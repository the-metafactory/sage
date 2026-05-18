/**
 * Forge-abstract types.
 *
 * Sage talks to multiple git-forge platforms (GitHub today, GitLab once
 * sage#43 lands). The bus contract, lens pipeline, and review workflow
 * stay forge-agnostic — they read PRs, fetch diffs, and post reviews
 * through the `ForgeBackend` interface, never against a specific CLI
 * tool. Per-forge implementations live under `src/forge/<kind>/`.
 *
 * Today `PrRef` is GitHub-shaped (`owner/repo#N`). GitLab merge-request
 * shaping arrives with sage#43 Phase 3 and may extend this shape with
 * a `kind` discriminator and an optional `host` for self-hosted
 * instances. The interface declared here is the contract that PR-shaped
 * change has to keep stable for cortex/pilot consumers downstream.
 */

import type { z } from "zod";

/**
 * Identifier of the forge platform. Discriminator for routing in
 * `selectForge` (sage#43 Phase 4). Today the only value sage emits is
 * `"github"`; `"gitlab"` becomes valid once the GitLab adapter lands.
 */
export type ForgeKind = "github" | "gitlab";

/**
 * Reference to a single PR/MR on a forge.
 *
 * The current shape is GitHub-flavoured (`owner` + `repo` segments).
 * sage#43 Phase 2 keeps this shape byte-stable so the refactor is a
 * pure relocation; Phase 3 (GitLab backend) decides whether to add a
 * `kind` discriminator + `host` field or fold GitLab's nested group
 * paths into `owner/repo`.
 */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Metadata returned by `ForgeBackend.prView`. Mirrors the subset of
 * `gh pr view --json` sage's lenses + renderer rely on. Fields are
 * named after their GitHub-API origins; GitLab adapter is responsible
 * for mapping `MergeRequest` payloads into this shape (sage#43 §Phase 3).
 */
export interface PrMetadata {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  author: { login: string };
  changedFiles: number;
  additions: number;
  deletions: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
  url: string;
}

export type ReviewEvent = "comment" | "approve" | "request-changes";

export interface PostReviewInput {
  ref: PrRef;
  event: ReviewEvent;
  body: string;
}

export interface PostReviewResult {
  /** Event the forge actually accepted. May be downgraded from input.event. */
  posted: ReviewEvent;
  /** True when the forge blocked self-{approve,request-changes} and we fell back. */
  downgraded: boolean;
}

/**
 * Prior-review finding parsed out of a previous Sage review body. Used
 * by lenses to suppress repeat findings on iterative reviews. The
 * markdown grammar is forge-agnostic — every backend's
 * `priorSageReviewFindings` reuses the same parser.
 */
export interface PriorReviewFinding {
  path: string;
  line: number;
  severity: "blocker" | "important" | "suggestion" | "nit";
  title: string;
}

export interface AuthStatusResult {
  ok: boolean;
  output: string;
}

/**
 * Platform-neutral interface for sage's forge operations. Each
 * `ForgeKind` ships exactly one implementation under
 * `src/forge/<kind>/backend.ts`.
 *
 * The contract is intentionally narrow — only the operations the
 * review workflow actually uses. Richer forge surfaces (issue
 * tracking, label management, project queries) belong elsewhere; sage
 * is a review agent, not a forge client library.
 *
 * Lifecycle: a `ForgeBackend` instance is resolved once per CLI
 * invocation or per bus task by `selectForge()` (sage#43 Phase 4) and
 * threaded through `ReviewOptions.forge` into every lens-pipeline
 * call. The same instance is reused for `prView` + `prDiff` +
 * `postReview` of one review — never per-call construction.
 */
export interface ForgeBackend {
  readonly kind: ForgeKind;

  /**
   * Parse a user-supplied PR/MR reference string. Implementations
   * accept their own URL form (`https://github.com/.../pull/N` for
   * GitHub, `https://gitlab.com/group/proj/-/merge_requests/N` for
   * GitLab) plus the shared `OWNER/REPO#N` shorthand.
   *
   * Throws on unrecognized input.
   */
  parseRef(input: string): PrRef;

  /** Fetch PR/MR metadata. */
  prView(ref: PrRef): Promise<PrMetadata>;

  /** Fetch the unified diff for the PR/MR. */
  prDiff(ref: PrRef): Promise<string>;

  /** Post a review back to the forge. Returns the event actually accepted. */
  postReview(input: PostReviewInput): Promise<PostReviewResult>;

  /**
   * Fetch findings from prior Sage reviews on this PR/MR. Used by
   * lenses to suppress repeat findings on iterative review cycles.
   */
  priorSageReviewFindings(ref: PrRef): Promise<PriorReviewFinding[]>;

  /** Cheap auth-health probe. */
  authStatus(): Promise<AuthStatusResult>;
}

/**
 * Zod schema for `PrMetadata`. Re-exported here so per-forge backends
 * that need to validate raw forge-API JSON can reuse the same shape,
 * but the canonical type stays platform-neutral.
 *
 * The schema definition itself is owned by each backend (GitHub
 * shapes it from `gh pr view --json`; GitLab shapes it from
 * `glab api`). This type alias lets the schemas declare their parsed
 * output shape using the shared `PrMetadata` interface.
 */
export type PrMetadataSchemaType = z.ZodType<PrMetadata>;
