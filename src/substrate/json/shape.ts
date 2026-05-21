/**
 * Lens contract predicate. The lens prompt asks the model for an
 * object with `summary` + `findings`; this is the cheapest possible
 * signal that a parsed JSON value matches that contract.
 *
 * Lives in its own leaf module so both `extractors.ts` (used inside
 * `CLAUDE_ENVELOPE` for the inner-string recovery path) and
 * `pipelines.ts` (used as `JsonPipeline.preferredShape`) can import
 * it without a cycle. One predicate, one source (sage#57 → sage#63
 * Sage review #3 Architecture suggestion).
 */
export function isLensShaped(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return "summary" in obj || "findings" in obj;
}
