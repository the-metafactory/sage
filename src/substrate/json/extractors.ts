/**
 * Substrate JSON extraction Module — extractor primitives.
 *
 * Each `NamedExtractor` is one strategy for pulling a candidate JSON
 * value out of substrate text. Pipelines compose them in order.
 *
 * Strategies preserved byte-for-byte from the previous
 * `src/substrate/json.ts` so weakening / strengthening any strategy is
 * a deliberate decision, not an accident of refactor (sage#57
 * acceptance criterion).
 *
 *   - RAW                  — JSON.parse the trimmed text directly. Happy
 *                            path for contract-obeying models.
 *   - FENCED_LAST_FIRST    — all ```…``` fenced blocks, LAST first.
 *                            Verbose models put the final answer in
 *                            the last block.
 *   - BALANCED_LARGEST     — all `{…}` balanced spans, LARGEST first.
 *                            Reasoning traces often include small
 *                            example objects; the real reply is
 *                            usually the longest span.
 *   - TRAILING             — walks backwards from the last `}` to
 *                            find the "prose + JSON at very end" shape.
 *   - CLAUDE_ENVELOPE      — claude `--output-format json` envelope:
 *                            parse the wrapper, return the `.result` /
 *                            `.response` inner string (or the wrapper
 *                            itself if it's bare lens-shaped JSON).
 */

import { runTextStrategies } from "./run-strategies.ts";
import type { NamedExtractor } from "./types.ts";

export const RAW: NamedExtractor = {
  name: "raw",
  extract(text) {
    return tryJsonParse(text);
  },
};

export const FENCED_LAST_FIRST: NamedExtractor = {
  name: "fenced-last-first",
  extract(text) {
    for (const block of allFencedBlocks(text).reverse()) {
      const parsed = tryJsonParse(block);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  },
};

export const BALANCED_LARGEST: NamedExtractor = {
  name: "balanced-largest",
  extract(text) {
    const all = findAllBalancedObjects(text).sort((a, b) => b.length - a.length);
    for (const candidate of all) {
      const parsed = tryJsonParse(candidate);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  },
};

export const TRAILING: NamedExtractor = {
  name: "trailing",
  extract(text) {
    const trailing = findTrailingBalancedObject(text);
    if (!trailing) return undefined;
    return tryJsonParse(trailing);
  },
};

/**
 * claude `--output-format json` envelope extractor. The envelope's
 * `.result` (or legacy `.response`) field carries the inner string the
 * assistant produced; that inner string is what callers want. Bare
 * envelopes that *are* already the lens body (some claude versions
 * print it that way when no tools were used) pass through unchanged.
 *
 * When the inner string doesn't parse bare, the four text-extraction
 * strategies (RAW/FENCED_LAST_FIRST/BALANCED_LARGEST/TRAILING) run
 * against the *inner* string — NOT the outer envelope. The outer
 * envelope encodes newlines as `\n` literals, so the fence regex and
 * balanced-object walks would never match the lens body inside a
 * fenced reply at the outer level. This preserves the byte-for-byte
 * behavior of the prior `tryParseClaudeEnvelope` (sage#57 → sage#63
 * Sage review blocker).
 *
 * Returns `undefined` when stdout isn't JSON at all OR the envelope
 * carries `.result` / `.response` but no extractor can recover lens
 * shape from it — in that case the next Pipeline extractor gets a
 * shot at the raw outer stdout (degraded path; in practice the bare
 * parse + inner 4-tier covers every observed shape).
 */
export const CLAUDE_ENVELOPE: NamedExtractor = {
  name: "claude-envelope",
  extract(text) {
    const envelope = tryJsonParse(text);
    if (envelope === undefined) return undefined;
    const inner = pickClaudeResultText(envelope);
    if (inner !== undefined) {
      // Delegate the inner-string recovery to the shared two-pass
      // walker over the four text strategies. Same algorithm the
      // outer Pipeline uses — one source of truth (sage#63 round-4
      // Maintainability finding: collapses duplication).
      //
      // No inner-shape preference — Pass 1 always falls through to
      // Pass 2 ("first parseable wins") because Lens-shape knowledge
      // is now a caller-side concern (sage#73). For Claude's typical
      // single-JSON inner string this is identical to the prior
      // isLensShaped default; for malformed multi-JSON inner strings
      // the result becomes order-driven instead of shape-driven.
      return runTextStrategies(
        inner,
        [RAW, FENCED_LAST_FIRST, BALANCED_LARGEST, TRAILING],
        () => false,
      ).value;
    }
    // No .result / .response — envelope itself may be the lens body.
    return envelope;
  },
};


function pickClaudeResultText(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const obj = envelope as Record<string, unknown>;
  if (typeof obj.result === "string") return obj.result;
  if (typeof obj.response === "string") return obj.response;
  return undefined;
}

function tryJsonParse(text: string): unknown | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
    // Treat `i === 0` as not-escaped (no preceding char to be a
    // backslash). Avoids relying on `text[-1] === undefined !== "\\"`
    // coercion to express the same intent.
    const prevIsEscape = i > 0 && text[i - 1] === "\\";
    if (inString) {
      if (ch === '"' && !prevIsEscape) inString = false;
      continue;
    }
    if (ch === '"' && !prevIsEscape) {
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

/**
 * Default text-extraction strategy. Used by Substrates whose stdout
 * is the assistant's raw text (`pi`, `codex`). Four strategies, in
 * order:
 *   1. RAW
 *   2. FENCED_LAST_FIRST
 *   3. BALANCED_LARGEST
 *   4. TRAILING
 *
 * Composed into a `JsonPipeline` at the call site with a caller-
 * supplied `preferredShape` predicate. The Lens kernel pairs this
 * with `isLensShaped` (`src/lenses/shape.ts`); other callers can
 * pair it with a different shape (sage#73).
 */
export const TEXT_EXTRACTORS: readonly NamedExtractor[] = [
  RAW,
  FENCED_LAST_FIRST,
  BALANCED_LARGEST,
  TRAILING,
];

/**
 * claude strategy. Starts with the native envelope extractor; falls
 * back to the same four text strategies when stdout isn't an envelope
 * (upstream shape change, mid-stream prose). Composed into a
 * `JsonPipeline` at the call site (sage#73).
 */
export const CLAUDE_EXTRACTORS: readonly NamedExtractor[] = [
  CLAUDE_ENVELOPE,
  RAW,
  FENCED_LAST_FIRST,
  BALANCED_LARGEST,
  TRAILING,
];
