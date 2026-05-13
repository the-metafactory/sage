import type { SubstrateRunOptions, SubstrateRunResult } from "./types.ts";

/**
 * JSON-extraction utilities for substrate output.
 *
 * Separated from `base.ts` (which owns subprocess spawning) so each
 * module has a single concern. `claude.ts` uses `extractJson` directly
 * to recover lens data from its native-envelope inner string;
 * `pi.ts` uses `runJsonViaTextExtraction` to run the full extract-or-
 * throw pipeline against pi's text output.
 *
 * Strategy (preserved byte-for-byte from the previous src/pi/runner.ts):
 *   0. Raw text — happy path for contract-obeying models.
 *   1. All fenced blocks, LAST first — verbose models put the final
 *      answer in the last fenced block.
 *   2. All balanced-brace objects, LARGEST first — reasoning traces
 *      often include example JSON; the real review is usually the
 *      longest span.
 *   3. Trailing balanced object — walks backwards from the last `}` to
 *      find the "reasoning trace + JSON at very end" shape.
 *
 * `extractJson` prefers lens-shaped parses (`{ summary | findings }`)
 * over arbitrary JSON to minimize false positives from example objects
 * inside a reasoning trace.
 */

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
      if (isLensShaped(parsed)) {
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

/**
 * Lens contract predicate. The lens prompt asks the model for an object
 * with `summary` + `findings`; this is the cheapest possible signal that
 * a parsed JSON value matches that contract. Used in two places:
 *   - `extractJson` (above) to prefer lens-shaped over arbitrary JSON.
 *   - `ClaudeSubstrate.runJson` to decide whether a raw envelope is
 *     itself the lens body (some claude versions print the lens JSON
 *     bare when no tools were invoked).
 */
export function isLensShaped(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return "summary" in obj || "findings" in obj;
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
