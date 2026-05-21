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

import type { NamedExtractor } from "./types.ts";

export const RAW: NamedExtractor = {
  name: "raw",
  extract(text) {
    return tryJsonParse(text.trim());
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
    const envelope = tryJsonParse(text.trim());
    if (envelope === undefined) return undefined;
    const inner = pickClaudeResultText(envelope);
    if (inner !== undefined) {
      // 1. Inner as JSON directly.
      const innerParsed = tryJsonParse(inner.trim());
      if (innerParsed !== undefined) return innerParsed;
      // 2. Run the four text strategies against the inner string. The
      //    same two-pass shape preference logic the top-level Pipeline
      //    uses applies here, scoped to the inner content. Lens-shaped
      //    candidate wins over any-parseable.
      const innerOut = extractLensShapedFromText(inner);
      if (innerOut !== undefined) return innerOut;
      return undefined;
    }
    // No .result / .response — envelope itself may be the lens body.
    return envelope;
  },
};

/**
 * Run the four text-extraction strategies against a string and return
 * the first lens-shaped hit, falling back to the first any-parseable
 * hit. Used by `CLAUDE_ENVELOPE` to dig into the envelope's inner
 * `.result` string when bare parse fails (sage#57 acceptance
 * criterion: 4-tier text extraction preserved byte-for-byte). Kept
 * private to this module so the public Pipeline shape stays simple.
 */
function extractLensShapedFromText(text: string): unknown | undefined {
  // Build candidate set once — mirrors the prior `extractJson` shape.
  const candidates: string[] = [];
  candidates.push(text);
  for (const block of allFencedBlocks(text).reverse()) candidates.push(block);
  for (const balanced of findAllBalancedObjects(text).sort(
    (a, b) => b.length - a.length,
  )) {
    candidates.push(balanced);
  }
  const trailing = findTrailingBalancedObject(text);
  if (trailing) candidates.push(trailing);

  // Pass 1: prefer lens shape.
  for (const c of candidates) {
    const parsed = tryJsonParse(c.trim());
    if (parsed !== undefined && isLensShapedLite(parsed)) return parsed;
  }
  // Pass 2: any-parseable.
  for (const c of candidates) {
    const parsed = tryJsonParse(c.trim());
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Local copy of the lens-shape predicate to avoid an import cycle
 * with `pipelines.ts`. Same byte-for-byte semantics: object with
 * `summary` OR `findings`.
 */
function isLensShapedLite(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return "summary" in obj || "findings" in obj;
}

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
