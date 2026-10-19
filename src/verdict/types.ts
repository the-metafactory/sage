import type { LensReport } from "../lenses/types.ts";
import type { ConvergenceSummary } from "./convergence.ts";
import type { CheckedClaims } from "../util/claims.ts";

/**
 * The decision output of a Review — exactly one of `approved`,
 * `changes-requested`, `commented`, or `incomplete` (CONTEXT.md). Produced by
 * `decideVerdict()` from the LensReports a Review collected.
 *
 * A `changes-requested` decision is **earned, not assumed**: at least
 * one Finding of Severity `blocker`, OR an `important`-severity Finding
 * whose Finding impact is `behavior` or `check` (or is unclassified).
 * An errored Lens yields `incomplete`, requiring a retry, not a code fix. An
 * `important` Finding that changes only wording does NOT block — that
 * gate is what lets an autonomous review loop terminate. Severity and
 * impact calibration are owned by `decideVerdict` — downstream
 * consumers branch on `decision` only.
 */
export interface Verdict {
  decision: "approved" | "changes-requested" | "commented" | "incomplete";
  summary: string;
  lenses: LensReport[];
  /** Additive round-progress signal for autonomous review loops (sage#107). */
  convergence?: ConvergenceSummary;
  /**
   * The claims the HonestOracle actually checked this round, and the commit it
   * read (sage#107, sage#139). Set only when the Oracle ran and returned a usable report, so
   * the marker never asserts that claims nobody read have been checked.
   *
   * The next Review reads it back off the posted body to answer "are there new
   * claims?" — the question the Oracle's PR-description trigger needs and
   * cannot answer from a diff.
   */
  checkedClaims?: CheckedClaims;
  /**
   * The PR head this Review read. Rendered as a hidden marker so a Review
   * posted as a plain PR comment (ranger's offline rounds) still tells the
   * next round where Sage left off.
   */
  reviewedCommitId?: string;
}
