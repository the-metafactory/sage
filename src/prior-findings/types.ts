/**
 * Prior Findings Module — types.
 *
 * Owns the trust-gating, parsing, and dedup of Sage's prior Findings on
 * the same PR across review iterations (see CONTEXT.md — Prior
 * Findings). Sits above the Forge backend: each Forge declares a
 * narrow `ForgeReviewSource` Port (whose shape is defined in
 * `forge/types.ts` so the layering reads cleanly — Forge owns the
 * Port shape, Module owns the orchestration), and the Module
 * synthesizes a `PriorFindingsResult` whose `status` is first-class so
 * workflow callers can surface degraded paths onto the Lifecycle
 * envelope without having to introspect exceptions.
 *
 * The `ForgeReviewSource` Port is re-exported from here as a
 * convenience so Module callers (`createPriorFindings`,
 * `createInMemoryReviewSource`, Adapter modules) need a single import
 * surface.
 */

import type { PrRef, PriorReviewFinding } from "../forge/types.ts";

export type {
  ForgeReviewSource,
  ForgeReviewSourceResult,
  ForgeReviewBody,
} from "../forge/types.ts";

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
 * The Module's external Interface. One method. Never throws — every
 * failure mode is observable via `PriorFindingsResult.status`.
 */
export interface PriorFindings {
  collect(ref: PrRef): Promise<PriorFindingsResult>;
}
