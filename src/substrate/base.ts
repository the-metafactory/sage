import { spawn } from "node:child_process";

import type { SubstrateRunOptions, SubstrateRunResult } from "./types.ts";

/**
 * Shared subprocess + JSON-extraction primitives for substrates.
 *
 *   - `spawnSubstrate` — spawn a binary, buffer stdout/stderr, enforce a
 *     timeout via SIGKILL, write optional stdin, return the captured
 *     streams. Lifted out of `pi.ts` and `claude.ts` so substrate
 *     implementations share one canonical spawn path (sage#15 review:
 *     duplicate ~45-line spawn blocks were the main duplication signal).
 *   - `runJsonViaTextExtraction` — for substrates without a native
 *     structured-output mode. Same forgiving strategy as the previous
 *     `src/pi/runner.ts` (raw → fenced → balanced-brace → trailing), same
 *     lens-shape preference.
 *   - `extractJson` (re-exported) — exposed so substrates with a native
 *     JSON mode can salvage the lens body from the *already-captured*
 *     stdout when the native envelope parse fails, instead of paying for
 *     a second LLM round-trip.
 */

export interface SpawnSubstrateInput {
  /** Binary name or path. */
  bin: string;
  /** Argv to pass after the binary. */
  args: string[];
  /** Substrate-specific env (already built via `buildSubstrateEnv`). */
  env: Record<string, string>;
  /** Optional working directory. */
  cwd?: string;
  /** Optional stdin payload (large content too big for argv). */
  stdin?: string;
  /** Hard timeout in ms. Substrate is SIGKILLed on expiry. */
  timeoutMs: number;
  /**
   * Short label used in error messages and the after-close stdin warning
   * (e.g. `pi`, `claude`). Lets a future substrate add itself without
   * patching the spawn path.
   */
  label: string;
}

export async function spawnSubstrate(input: SpawnSubstrateInput): Promise<SubstrateRunResult> {
  const started = Date.now();
  return new Promise<SubstrateRunResult>((resolve, reject) => {
    const child = spawn(input.bin, input.args, {
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${input.label} substrate timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
      });
    });

    // Write any large content via stdin BEFORE we'd otherwise hit ARG_MAX
    // on the argv path. Wrap in try/catch — if the child exited in the
    // same tick (e.g., binary missing), stdin may already be ended and
    // `write/end` would otherwise become an unhandled rejection.
    try {
      if (input.stdin !== undefined) child.stdin.write(input.stdin);
      child.stdin.end();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[sage:${input.label}] stdin write/end after-close: ${m}`);
    }
  });
}

export async function runJsonViaTextExtraction<T>(
  run: (opts: SubstrateRunOptions) => Promise<SubstrateRunResult>,
  opts: SubstrateRunOptions,
): Promise<{ result: T; raw: SubstrateRunResult }> {
  const raw = await run(opts);
  if (raw.exitCode !== 0) {
    throw new Error(
      `substrate exited with code ${raw.exitCode}: ${raw.stderr || raw.stdout}`,
    );
  }
  const text = raw.stdout.trim();
  if (!text) throw new Error("substrate returned empty output");

  const parsed = extractJson<T>(text);
  if (parsed === undefined) {
    throw new Error(
      `substrate output is not valid JSON (tried raw, fenced, and prose-wrapped extraction)\n--- output ---\n${text}`,
    );
  }
  return { result: parsed, raw };
}

/**
 * Pull a JSON object out of an arbitrary substrate response. Tries shapes in
 * order, returning the first parse that "looks lens-shaped" (has `summary` /
 * `findings`); otherwise returns the first parseable object/array.
 *
 *   0. Raw text — happy path for contract-obeying models.
 *   1. All fenced blocks, LAST first — verbose models put the final answer
 *      in the last fenced block.
 *   2. All balanced-brace objects, LARGEST first — reasoning traces often
 *      include example JSON; the real review is usually the longest span.
 *   3. Trailing balanced object — walks backwards from the last `}` to find
 *      "reasoning trace + JSON at very end" shape.
 */
export function extractJson<T>(text: string): T | undefined {
  const candidates: string[] = [];

  candidates.push(text);

  for (const block of allFencedBlocks(text).reverse()) {
    candidates.push(block);
  }

  const balancedAll = findAllBalancedObjects(text).sort((a, b) => b.length - a.length);
  for (const b of balancedAll) candidates.push(b);

  const trailing = findTrailingBalancedObject(text);
  if (trailing) candidates.push(trailing);

  // Prefer lens-shaped JSON first — minimizes false positives where a
  // smaller example object inside a reasoning trace would otherwise win.
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        ("summary" in parsed || "findings" in parsed)
      ) {
        return parsed as T;
      }
    } catch {
      // try next
    }
  }

  // Last resort — any parseable JSON.
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function findAllBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("{", cursor);
    if (start === -1) break;
    const span = walkBalanced(text, start);
    if (span) {
      objects.push(span);
      cursor = start + span.length;
    } else {
      cursor = start + 1;
    }
  }
  return objects;
}

function findTrailingBalancedObject(text: string): string | undefined {
  const end = text.lastIndexOf("}");
  if (end === -1) return undefined;

  let depth = 0;
  let inString = false;

  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && text[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' && text[i - 1] !== "\\") {
      inString = true;
      continue;
    }
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return undefined;
}

function walkBalanced(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function allFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) blocks.push(m[1]);
  }
  return blocks;
}
