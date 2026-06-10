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

import { z } from "zod";

/**
 * Identifier of the forge platform. Discriminator for routing in
 * `selectForge` (sage#43 Phase 4). Today the only value sage emits is
 * `"github"`; `"gitlab"` becomes valid once the GitLab adapter lands.
 */
export type ForgeKind = "github" | "gitlab";

/**
 * Reference to a single PR/MR on a forge.
 *
 * `owner/repo` is the GitHub-flavoured segment pair; GitLab adapters
 * map their `group(/subgroup)/project` path into the same fields
 * (last segment → `repo`, the rest → `owner`) so the bus payload
 * shape stays stable across forges. `kind` defaults to `"github"`
 * when omitted to preserve back-compat on existing dispatch payloads
 * (sage#43 §Phase 5 — additive field). `host` is set by GitLab
 * adapters pointing at self-hosted instances; GitHub omits it.
 */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** Forge kind. Omitted ⇒ `"github"` (back-compat default). */
  kind?: ForgeKind;
  /** Forge host for self-hosted instances. GitHub omits it. */
  host?: string;
}

/**
 * Zod schema for `PrMetadata`. Canonical shape lives here so the
 * platform-neutral interface and per-backend validators share a
 * single source of truth — a metadata field change happens in one
 * place, not two (sage review on #45, Maintainability lens).
 *
 * Each per-forge backend (`prView`) maps its raw API JSON into this
 * shape and runs it through `PrMetadataSchema.parse` to catch drift
 * before the lens pipeline sees a malformed payload.
 */
export const PrMetadataSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().transform((s) => s ?? ""),
  state: z.string(),
  isDraft: z.boolean(),
  baseRefName: z.string(),
  headRefName: z.string(),
  /**
   * PR/MR head commit SHA. Sourced by the verdict block's `commit_id`
   * (cortex review-pipeline contract). Defaults to "" so pre-existing
   * `PrMetadata` fixtures that omit it stay schema-valid; the live github
   * / gitlab backends always populate it.
   */
  headRefOid: z.string().default(""),
  author: z.object({ login: z.string() }),
  changedFiles: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  files: z
    .array(
      z.object({
        path: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    )
    .default([]),
  url: z.string().url(),
});

/**
 * Metadata returned by `ForgeBackend.prView`. Inferred from
 * `PrMetadataSchema` to keep the type and the validator in lockstep.
 */
export type PrMetadata = z.infer<typeof PrMetadataSchema>;

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

export interface RepoFileOptions {
  /**
   * Branch/tag/SHA to read from. Review workflow passes the PR base
   * branch so repository context reflects the contract being merged
   * into, not the reviewer's installed sage checkout.
   */
  refName?: string;
}

/**
 * Prior-review finding parsed out of a previous Sage review body. Used
 * by lenses to suppress repeat findings on iterative reviews. The
 * markdown grammar is forge-agnostic — every Forge's
 * `ForgeReviewSource` Adapter feeds bodies into the shared parser in
 * `src/forge/prior-findings.ts`; trust-gating + dedup + enrichment
 * live in the Prior Findings Module (`src/prior-findings/`).
 *
 * `lensClass` and `postedAt` are additive (sage#56) — old review
 * bodies parse with these undefined, and the workflow keeps reading
 * `readonly PriorReviewFinding[]` so no Lens file changes.
 */
export interface PriorReviewFinding {
  path: string;
  line: number;
  severity: "blocker" | "important" | "suggestion" | "nit";
  title: string;
  /** Lens-name attribution when the source body carried a heading. */
  lensClass?: string;
  /** ISO-8601 timestamp from the source review body. */
  postedAt?: string;
}

export interface AuthStatusResult {
  ok: boolean;
  output: string;
}

/**
 * Platform-primitive Port consumed by the Prior Findings Module
 * (`src/prior-findings/`). Defined here, not in the Module, so the
 * layering reads cleanly — the Forge owns the Port shape (it's the
 * lower-layer thing being adapted), the Module owns the orchestration
 * that consumes it. One Adapter per Forge backend.
 *
 * Contract:
 *   - Pre-filters system / diff-pinned notes (they cannot be a Sage
 *     review).
 *   - Returns bodies oldest-first; the Module preserves that order.
 *   - Resolves the Sage identity internally — the Adapter knows the
 *     Forge's user API and caches per-host inside its closure.
 *   - `sageLogin === null` ⇒ identity could not be resolved (env
 *     unset AND the Forge's user API failed). The Module maps this to
 *     `PriorFindingsResult.status = "trust-gate-failed"`.
 */
export interface ForgeReviewSource {
  fetchReviewBodies(ref: PrRef): Promise<ForgeReviewSourceResult>;
}

export interface ForgeReviewSourceResult {
  readonly bodies: readonly ForgeReviewBody[];
  readonly sageLogin: string | null;
}

export interface ForgeReviewBody {
  readonly authorLogin: string;
  readonly body: string;
  /**
   * ISO-8601 timestamp from the Forge's review/note record. `undefined`
   * when the Forge omitted it. The Module forwards present values
   * onto `PriorReviewFinding.postedAt`; `undefined` passes through
   * unchanged — no empty-string sentinel in the Module's contract.
   */
  readonly postedAt?: string;
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

  /**
   * Fetch a repository file as UTF-8 text. Missing files return null;
   * transport/auth/schema failures throw so the caller can decide
   * whether that context source is optional.
   */
  repoFile(ref: PrRef, path: string, opts?: RepoFileOptions): Promise<string | null>;

  /** Post a review back to the forge. Returns the event actually accepted. */
  postReview(input: PostReviewInput): Promise<PostReviewResult>;

  /**
   * Construct the `ForgeReviewSource` Adapter for this Forge — the
   * platform-primitive Port consumed by the Prior Findings Module
   * (`src/prior-findings/`). Trust-gating, parsing, and dedup all
   * happen in the Module; the Adapter only knows how to fetch raw
   * review bodies + resolve the Sage identity for this Forge
   * (sage#56).
   */
  reviewSource(): ForgeReviewSource;

  /** Cheap auth-health probe. */
  authStatus(): Promise<AuthStatusResult>;
}
