/**
 * Task Envelope Module — pure (no I/O, no clock, no env reads).
 *
 * Builds the spec for a code-review Task envelope from CLI inputs
 * (PrRef, post flag, forge, etc.). Sage's `dispatch` CLI composes the
 * outputs of this Module with the Bus Client Module
 * (`src/bus/client.ts`) and the Lifecycle Interpreter Module
 * (`src/bus/lifecycle.ts`) — the seam between domain shape and
 * transport mechanics (sage#58).
 *
 * `principal` is the canonical CONTEXT.md term for the sovereignty
 * segment of a Subject. The CLI flag `--org` stays for back-compat at
 * the outermost layer; the rename happens at this Module's boundary.
 */

import {
  deriveLifecycleWildcard,
  verdictWildcard,
} from "@the-metafactory/myelin";

import type { PrRef } from "../forge/types.ts";
import { describeEmission } from "./emissions.ts";
import type { DispatchTaskPayload } from "./types.ts";

export type ForgeKind = "github" | "gitlab";

/**
 * A `TaskEnvelopeSpec` is the data needed to publish exactly one Task
 * envelope. Subject + envelope type are pre-derived; payload is fully
 * built per cortex#237 §4.1; capability tag is the routing key cortex
 * uses for Offer Dispatch.
 */
export interface TaskEnvelopeSpec {
  readonly subject: string;
  readonly type: string;
  readonly payload: DispatchTaskPayload;
  readonly capability: string;
}

export interface BuildTaskEnvelopeSpecInput {
  readonly ref: PrRef;
  readonly principal: string;
  readonly stack: string;
  readonly post: boolean;
  readonly timeoutSeconds?: number;
  readonly forge?: ForgeKind;
  readonly reviewer?: string;
}

const DEFAULT_CAPABILITY = "code-review.typescript";

/**
 * Pure constructor for a `TaskEnvelopeSpec`. No I/O, no clock, no env
 * reads. Encapsulates the payload-shape rules previously in
 * `buildReviewTaskPayload`:
 *
 *   - `payload.post` is `true | omitted`, never `false` (sage#8).
 *   - `payload.forge` is omitted when `"github"` so legacy receivers
 *     see byte-stable shape (sage#43 Q3).
 *   - `reviewer` defaults to `"capability-dispatch"` to document that
 *     cortex routes by capability, not reviewer name (sage#52).
 *   - Both cortex#237 §4.1 contract (`repo` + `pr` + `reviewer`) AND
 *     legacy `pr_url` are populated for cross-grammar receivers.
 */
export function buildTaskEnvelopeSpec(
  input: BuildTaskEnvelopeSpecInput,
): TaskEnvelopeSpec {
  const forge: ForgeKind = input.forge ?? input.ref.kind ?? "github";
  const payload: DispatchTaskPayload = {
    repo: `${input.ref.owner}/${input.ref.repo}`,
    pr: input.ref.number,
    reviewer: input.reviewer ?? "capability-dispatch",
    pr_url: buildRefUrl(input.ref),
    ...(input.post ? { post: true as const } : {}),
    ...(input.timeoutSeconds ? { timeout_ms: input.timeoutSeconds * 1000 } : {}),
    ...(forge !== "github" ? { forge } : {}),
  };

  const { subject, type } = describeEmission(input.principal, input.stack, {
    kind: "task",
    capability: DEFAULT_CAPABILITY,
    payload: payload as Record<string, unknown>,
  });

  return {
    subject,
    type,
    payload,
    capability: DEFAULT_CAPABILITY,
  };
}

/**
 * Build the operator-facing PR/MR URL for a `PrRef`. Stamped on the
 * Task envelope as `payload.pr_url` for back-compat with pre-cortex#237
 * receivers; cortex's own pipeline reads `repo`+`pr` and ignores this.
 *
 * GitLab branch picks the host from `ref.host` when set, falling back
 * to `gitlab.com`.
 */
export function buildRefUrl(ref: PrRef): string {
  const kind = ref.kind ?? "github";
  if (kind === "gitlab") {
    const host = ref.host ?? "gitlab.com";
    return `https://${host}/${ref.owner}/${ref.repo}/-/merge_requests/${ref.number}`;
  }
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

/**
 * Lifecycle subject the dispatcher subscribes to. Wildcard form so
 * one subscription captures every action (`started`, `progress`,
 * `completed`, `failed`, `post-failed`). Filtering by
 * `correlation_id` lives in the consumer.
 */
export function deriveLifecycleSubject(principal: string, stack: string): string {
  return deriveLifecycleWildcard(principal, stack);
}

/**
 * Verdict subject the dispatcher subscribes to. Wildcard form so
 * one subscription captures all three verdict decisions.
 */
export function deriveVerdictSubject(principal: string, stack: string): string {
  return verdictWildcard(principal, "review", stack);
}

/**
 * Match an inbound envelope against the dispatch's published envelope
 * id. Per cortex#237 §5.x, cortex stamps the inbound envelope's `id`
 * as the `correlation_id` on every emitted lifecycle + verdict
 * envelope. The dispatcher subscribes to those subjects and uses this
 * function as the per-message filter.
 *
 * Pre-sage#53 the dispatcher filtered against its own self-generated
 * correlationId, which never matched cortex's echo — every dispatch
 * timed out. This pure helper pins the contract so the regression
 * can't recur (sage#58 keeps it pure + in-Module).
 */
export function matchesPublishedEnvelope(
  inbound: { correlation_id?: string },
  publishedEnvelopeId: string,
): boolean {
  return inbound.correlation_id === publishedEnvelopeId;
}
