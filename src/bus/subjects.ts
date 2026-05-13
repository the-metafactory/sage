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
 *   - Lifecycle:  local.{org}.dispatch.task.{started|progress|completed|failed}
 *   - Verdict:    local.{org}.code.pr.review.{approved|changes-requested|commented}
 *   - Post fail:  local.{org}.code.pr.review.post-failed (sage#16)
 *
 * Post-failed is a peer of the three verdict outcomes — same subject root
 * — so dispatcher-side `verdictWildcard` consumers receive it without a
 * separate subscription. It carries the same verdict + the post-attempt
 * error; the lens work itself succeeded and the verdict is on disk.
 */

export function broadcastSubject(cfg: SubjectConfig): string {
  return `local.${cfg.org}.tasks.code-review.>`;
}

export function directSubject(cfg: SubjectConfig): string {
  return `local.${cfg.org}.tasks.${encodeDidSegment(cfg.did)}.>`;
}

export function dispatchSubject(
  cfg: Pick<SubjectConfig, "org">,
  phase: "started" | "progress" | "completed" | "failed",
): string {
  return `local.${cfg.org}.dispatch.task.${phase}`;
}

export function verdictSubject(
  cfg: Pick<SubjectConfig, "org">,
  verdict: "approved" | "changes-requested" | "commented",
): string {
  return `local.${cfg.org}.code.pr.review.${verdict}`;
}

/**
 * Subject for the `post-failed` outcome — sibling of the three verdict
 * subjects above. Same root prefix so `verdictWildcard` consumers see it
 * without a second subscription. See sage#16.
 */
export function postFailedSubject(cfg: Pick<SubjectConfig, "org">): string {
  return `local.${cfg.org}.code.pr.review.post-failed`;
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
