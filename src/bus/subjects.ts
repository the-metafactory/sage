import { encodeDidSegment } from "./envelope.ts";

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
 */

export interface SubjectConfig {
  org: string;
  did: string;
}

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
