/**
 * Verdict Module — the decision output of a Review, plus its
 * derivations: markdown rendering, on-disk persistence, and the
 * Forge-API `ReviewEvent` mapping. Concentrated here so a Verdict's
 * life (decide → render → persist → optionally post) has one home,
 * not four.
 *
 * Public surface re-exported below. Internals (cross-lens dedupe,
 * severity ranking, finding-key normalization, fence picking) stay
 * private to their concern files.
 *
 * The persist-BEFORE-post ordering at the call site in
 * `lenses/workflow.ts` is deliberately a four-step sequence rather
 * than a facade (`produceVerdict`) — the ordering is a load-bearing
 * invariant from sage#16, and the explicit lines make it grep-able.
 */
export type { Verdict } from "./types.ts";
export { decideVerdict, verdictToEvent } from "./decide.ts";
export { renderVerdict } from "./render.ts";
export { renderVerdictBlock, mapFindingsToBuckets } from "./block.ts";
export type { VerdictBlockMeta, FindingsBuckets } from "./block.ts";
export { persistVerdict, verdictFilePath } from "./persist.ts";
