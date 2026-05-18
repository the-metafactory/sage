/**
 * Shared `ForgeBackend` stub for workflow-level tests. Centralizes
 * the boilerplate so future `ForgeBackend` interface changes flow
 * through one place instead of N test suites (sage review on #47,
 * Maintainability suggestion).
 *
 * Each suite passes the small set of fixtures it actually cares
 * about (`pr`, `diff`, `postReview` behavior); everything else
 * defaults to a no-op success path. The stub is intentionally not
 * typed against `ForgeBackend` directly so callers can hand in
 * minimal partial fixtures (e.g., a `prView` returning `stubPr as
 * never`) without having to satisfy the full `PrMetadata` shape
 * for unrelated lens tests.
 */

import type {
  ForgeBackend,
  PostReviewInput,
  PostReviewResult,
  PrMetadata,
  PrRef,
  PriorReviewFinding,
} from "../src/forge/types.ts";

export interface MakeStubForgeOptions {
  pr: PrMetadata | unknown;
  diff: string;
  /**
   * Override `postReview` to drive the post-step outcome (success,
   * throw, count calls). Default: returns `{ posted: "comment",
   * downgraded: false }` and increments no counter.
   */
  postReview?: (input: PostReviewInput) => Promise<PostReviewResult>;
  /** Override prior findings; default empty. */
  priorSageReviewFindings?: (ref: PrRef) => Promise<PriorReviewFinding[]>;
  /** Override `authStatus`; default `{ ok: true, output: "" }`. */
  authStatus?: () => Promise<{ ok: boolean; output: string }>;
}

export function makeStubForge(opts: MakeStubForgeOptions): ForgeBackend {
  return {
    kind: "github",
    parseRef: (ref: string) => {
      const m = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
      if (!m) throw new Error(`bad ref ${ref}`);
      return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
    },
    prView: async () => opts.pr as PrMetadata,
    prDiff: async () => opts.diff,
    priorSageReviewFindings: opts.priorSageReviewFindings ?? (async () => []),
    postReview:
      opts.postReview ??
      (async () => ({ posted: "comment", downgraded: false })),
    authStatus: opts.authStatus ?? (async () => ({ ok: true, output: "" })),
  };
}
