/**
 * Prior Findings Module — barrel.
 *
 * Public surface:
 *   - `createPriorFindings(source)` — Module factory.
 *   - `PriorFindings`, `PriorFindingsResult`, `PriorFindingsStatus` — Interface + result shape.
 *   - `ForgeReviewSource`, `ForgeReviewBody`, `ForgeReviewSourceResult` — Port.
 *   - `createGitHubReviewSource`, `createGitLabReviewSource` — production Adapters.
 *   - `createInMemoryReviewSource` — test Adapter.
 */

export { createPriorFindings } from "./collect.ts";
export { createInMemoryReviewSource } from "./in-memory-source.ts";
export { createGitHubReviewSource } from "./github-source.ts";
export { createGitLabReviewSource } from "./gitlab-source.ts";
export type {
  ForgeReviewBody,
  ForgeReviewSource,
  ForgeReviewSourceResult,
  PriorFindings,
  PriorFindingsResult,
  PriorFindingsStatus,
} from "./types.ts";
