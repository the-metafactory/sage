/**
 * Prior Findings Module — types.
 *
 * Owns the trust-gating, parsing, and dedup of Sage's prior Findings on
 * the same PR across review iterations (see CONTEXT.md — Prior
 * Findings). Sits above the Forge backend: each Forge declares a
 * narrow `ForgeReviewSource` Port returning raw review bodies plus the
 * resolved Sage identity, and the Module synthesizes a
 * `PriorFindingsResult` whose `status` is first-class so workflow
 * callers can surface degraded paths onto the Lifecycle envelope
 * without having to introspect exceptions.
 */

import type { PrRef, PriorReviewFinding } from "../forge/types.ts";

export type PriorFindingsStatus = "ok" | "trust-gate-failed" | "source-failed";

export interface PriorFindingsResult {
  readonly status: PriorFindingsStatus;
  readonly findings: readonly PriorReviewFinding[];
  /** Present iff status === "ok" — the identity used to gate trust. */
  readonly identity?: { readonly login: string };
  /** Present iff status !== "ok" — one human line for logs + Lifecycle envelope. */
  readonly reason?: string;
}

/**
 * Platform-primitive Port. One Adapter per Forge backend.
 *
 * - Pre-filters system / diff-pinned notes (they cannot be a Sage review).
 * - Returns bodies oldest-first; the Module preserves that order.
 * - Resolves Sage identity internally — the Adapter knows the Forge's
 *   user API and caches per-host inside its closure. No module-level
 *   globals.
 * - `sageLogin === null` ⇒ identity could not be resolved (env unset
 *   AND the user API call failed). The Module maps this to
 *   `PriorFindingsResult.status = "trust-gate-failed"`.
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
  readonly postedAt: string;
}

/**
 * The Module's external Interface. One method. Never throws — every
 * failure mode is observable via `PriorFindingsResult.status`.
 */
export interface PriorFindings {
  collect(ref: PrRef): Promise<PriorFindingsResult>;
}
