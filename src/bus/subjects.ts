import { encodeDidSegment } from "./envelope.ts";
import { type SubjectConfig } from "./types.ts";

export type { SubjectConfig };

/**
 * Subject helpers for Sage's bus participation.
 *
 * Inbound (subscribe):
 *   - Broadcast:  local.{org}.tasks.code-review.>
 *   - Direct:     local.{org}.tasks.@did-mf-sage.>
 *
 * Outbound (publish):
 *   - Lifecycle:  local.{org}.dispatch.task.{started|progress|completed|failed|post-failed}
 *   - Verdict:    local.{org}.code.pr.review.{approved|changes-requested|commented}
 *
 * Boundary: the `code.pr.review.>` root is reserved for *review outcomes*
 * (the persona's verdict on the PR). Operational signals like a GH-post
 * delivery failure (`post-failed`) live under the dispatch lifecycle
 * namespace, not the verdict namespace — they describe what happened to
 * the message, not the message itself. The previous placement under
 * `code.pr.review.post-failed` (sage#16 PR #20 round 1) conflated those
 * two concerns and forced verdict-wildcard consumers to filter.
 */

export function broadcastSubject(cfg: SubjectConfig): string {
  return `local.${cfg.org}.tasks.code-review.>`;
}

export function directSubject(cfg: SubjectConfig): string {
  return `local.${cfg.org}.tasks.${encodeDidSegment(cfg.did)}.>`;
}

export function dispatchSubject(
  cfg: Pick<SubjectConfig, "org">,
  phase: "started" | "progress" | "completed" | "failed" | "post-failed",
): string {
  return `local.${cfg.org}.dispatch.task.${phase}`;
}
// `post-failed` is in the phase union (not a separate function) because
// it IS just another lifecycle phase from the subject hierarchy's
// perspective. The earlier `postFailedSubject` wrapper added vocabulary
// without hiding anything — bridge.ts calls `dispatchSubject({org},
// "post-failed")` directly.

export function verdictSubject(
  cfg: Pick<SubjectConfig, "org">,
  verdict: "approved" | "changes-requested" | "commented",
): string {
  return `local.${cfg.org}.code.pr.review.${verdict}`;
}

/**
 * Concrete task subject for publishing — used by `sage dispatch` to send a
 * code-review request into the bus. Pairs with `broadcastSubject` (which
 * is the subscribe-side wildcard pattern).
 */
export function taskSubject(
  cfg: Pick<SubjectConfig, "org">,
  capability: string,
): string {
  return `local.${cfg.org}.tasks.${capability}`;
}

/**
 * Wildcard subscription patterns for dispatchers watching for lifecycle
 * + verdict envelopes coming back from a running Sage daemon.
 */
export function dispatchLifecycleWildcard(cfg: Pick<SubjectConfig, "org">): string {
  return `local.${cfg.org}.dispatch.task.>`;
}

export function verdictWildcard(cfg: Pick<SubjectConfig, "org">): string {
  return `local.${cfg.org}.code.pr.review.>`;
}
