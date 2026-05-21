/**
 * Pre-built `JsonPipeline` constants tied to specific Substrate
 * Adapters. Each Adapter declares one of these as its
 * `Substrate.jsonPipeline` — the divergence between claude (native
 * envelope) and pi/codex (text extraction) collapses from "different
 * code path in runJson" to "different Pipeline constant" (sage#57).
 */

import {
  BALANCED_LARGEST,
  CLAUDE_ENVELOPE,
  FENCED_LAST_FIRST,
  RAW,
  TRAILING,
} from "./extractors.ts";
import type { JsonPipeline } from "./types.ts";

/**
 * Lens contract predicate. The lens prompt asks the model for an
 * object with `summary` + `findings`; this is the cheapest possible
 * signal that a parsed JSON value matches that contract.
 *
 * Preserved byte-for-byte from `src/substrate/json.ts`'s
 * `isLensShaped` so the first-pass preference for lens shape produces
 * the same outcomes after the refactor (sage#57 acceptance criterion).
 */
export function isLensShaped(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return "summary" in obj || "findings" in obj;
}

/**
 * Default text-extraction Pipeline. Used by Substrates whose stdout
 * is the assistant's raw text (`pi`, `codex`). Four strategies, in
 * order:
 *   1. RAW
 *   2. FENCED_LAST_FIRST
 *   3. BALANCED_LARGEST
 *   4. TRAILING
 *
 * Two-pass resolution prefers lens-shape across all four before
 * falling back to any-parseable.
 */
export const TEXT_PIPELINE: JsonPipeline = {
  extractors: [RAW, FENCED_LAST_FIRST, BALANCED_LARGEST, TRAILING],
  preferredShape: isLensShaped,
};

/**
 * claude Pipeline. Starts with the native envelope extractor; falls
 * back to the same four text strategies when stdout isn't an envelope
 * (upstream shape change, mid-stream prose). Matches the prior
 * `ClaudeSubstrate.runJson` fallback behavior — never re-spawns,
 * never throws on extraction failure.
 */
export const CLAUDE_PIPELINE: JsonPipeline = {
  extractors: [CLAUDE_ENVELOPE, RAW, FENCED_LAST_FIRST, BALANCED_LARGEST, TRAILING],
  preferredShape: isLensShaped,
};
