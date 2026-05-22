import type { JsonPipeline, NamedExtractor } from "../substrate/json/types.ts";

/**
 * Lens contract predicate. The lens prompt asks the model for an
 * object with `summary` + `findings`; this is the cheapest possible
 * signal that a parsed JSON value matches that contract.
 *
 * Lives on the Lens side (not Substrate) because Lens shape is a
 * Lens-domain concern — the Substrate is pure platform per ISA
 * principle #1. Callers requesting JSON extraction supply this as
 * the Pipeline's `preferredShape`; the Substrate JSON Module no
 * longer carries a notion of "preferred shape" itself (sage#73 —
 * refines sage#57).
 */
export function isLensShaped(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return "summary" in obj || "findings" in obj;
}

/**
 * Build a `JsonPipeline` that pairs the given Substrate-side
 * extractor strategy with `isLensShaped` as the preferred shape.
 * One construction site for every Lens-targeted Pipeline — keeps
 * `lenses/base.ts` and Lens tests from drifting on the composition
 * shape (sage#73 review).
 */
export function makeLensPipeline(
  extractors: readonly NamedExtractor[],
): JsonPipeline {
  return { extractors, preferredShape: isLensShaped };
}
