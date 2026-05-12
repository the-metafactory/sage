import { spawn } from "node:child_process";

import { buildPiEnv } from "./env.ts";

/**
 * Pi.dev subprocess runner.
 *
 * Invokes the `pi` CLI from @earendil-works/pi-coding-agent in non-interactive
 * print mode. Returns either raw text (default) or a structured review object
 * when a JSON-shape prompt is used.
 */

export interface PiRunOptions {
  prompt: string;
  provider?: string;
  model?: string;
  tools?: readonly string[];
  apiKey?: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Extra env vars forwarded to `pi`. Merged on top of the allow-listed env
   * built by `buildPiEnv()`. Use this when a caller needs to inject a
   * provider key at runtime without mutating `process.env`.
   */
  env?: Record<string, string | undefined>;
  /** Extra keys to forward on top of the default allow-list. */
  envAllow?: readonly string[];
  /** Keys to strip even if otherwise allowed. */
  envDeny?: readonly string[];
}

export interface PiRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  const bin = process.env.PI_BIN ?? "pi";
  const provider = opts.provider ?? process.env.PI_PROVIDER;
  const model = opts.model ?? process.env.PI_MODEL;
  const apiKey = opts.apiKey ?? process.env.PI_API_KEY;

  const args: string[] = ["-p"];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (apiKey) args.push("--api-key", apiKey);
  if (opts.tools && opts.tools.length) args.push("--tools", opts.tools.join(","));
  args.push(opts.prompt);

  const started = Date.now();

  const childEnv = buildPiEnv({
    extra: opts.env,
    allow: opts.envAllow,
    deny: opts.envDeny,
  });

  return new Promise<PiRunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi runner timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
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

    child.stdin.end();
  });
}

/**
 * Run pi expecting a JSON object response. Handles three common wrapper
 * shapes in order: (1) raw JSON, (2) JSON inside ```json … ``` fences,
 * (3) JSON preceded/followed by prose. The lens prompt asks for raw JSON
 * but model outputs vary, so the extractor is forgiving.
 */
export async function runPiJson<T>(opts: PiRunOptions): Promise<{ result: T; raw: PiRunResult }> {
  const raw = await runPi(opts);
  if (raw.exitCode !== 0) {
    throw new Error(`pi exited with code ${raw.exitCode}: ${raw.stderr || raw.stdout}`);
  }

  const text = raw.stdout.trim();
  if (!text) throw new Error("pi returned empty output");

  const parsed = extractJson<T>(text);
  if (parsed === undefined) {
    throw new Error(
      `pi output is not valid JSON (tried raw, fenced, and prose-wrapped extraction)\n--- output ---\n${text}`,
    );
  }

  return { result: parsed, raw };
}

/**
 * Pull a JSON object out of an arbitrary pi response. Tries four shapes in
 * order, returning the first that parses cleanly:
 *
 *   0. Raw — the whole response is valid JSON (the system-prompt-obeyed case).
 *   1. Greedy fence — first opening ```json fence to LAST closing ```.
 *      Handles JSON bodies that contain inline ``` blocks inside
 *      `suggestion` fields (common in review output).
 *   2. Brace slice — first `{` to last `}`. Recovers from prose preambles
 *      ("Here is the review: {…}") and from greedy-fence over-capture.
 *   3. Non-greedy fence — first ```json fence to FIRST closing ```. Last
 *      resort for the rare two-separate-fenced-blocks shape.
 *
 * Returns `undefined` if all four fail.
 */
function extractJson<T>(text: string): T | undefined {
  // 0) Raw text — preserves the happy path.
  const candidates: string[] = [text];

  // 1) Greedy fence.
  const fenceGreedy = /^```(?:json)?\s*\n([\s\S]*)\n```\s*$/;
  const g = text.match(fenceGreedy);
  if (g && g[1]) candidates.push(g[1]);

  // 2) Brace slice with balanced-depth walk. Starts at the first `{` and
  //    advances until depth returns to zero, respecting string literals and
  //    escape sequences. Avoids feeding the parser a multi-megabyte string
  //    when pi emits diagnostic prose alongside the JSON.
  const balanced = findBalancedObject(text);
  if (balanced) candidates.push(balanced);

  // 3) Non-greedy fence.
  const fenceNonGreedy = /```(?:json)?\s*\n([\s\S]*?)\n```/;
  const ng = text.match(fenceNonGreedy);
  if (ng && ng[1]) candidates.push(ng[1]);

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

/**
 * Walk from the first `{` and return the smallest balanced object span.
 * Respects string literals (so `{` inside `"…"` doesn't increment depth)
 * and backslash escapes. Returns undefined if the braces are unbalanced.
 */
function findBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

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
