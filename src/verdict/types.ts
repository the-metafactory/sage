import type { LensReport } from "../lenses/types.ts";
import type { ConvergenceSummary } from "./convergence.ts";

/**
 * The decision output of a Review — exactly one of `approved`,
 * `changes-requested`, `commented` (CONTEXT.md). Produced by
 * `decideVerdict()` from the LensReports a Review collected.
 *
 * A `changes-requested` decision is **earned, not assumed**: at least
 * one Finding of Severity `blocker`, OR an `important`-severity Finding
 * whose Finding impact is `behavior` or `check` (or is unclassified),
 * OR an errored Lens (a lens that did not produce a usable verdict). An
 * `important` Finding that changes only wording does NOT block — that
 * gate is what lets an autonomous review loop terminate. Severity and
 * impact calibration are owned by `decideVerdict` — downstream
 * consumers branch on `decision` only.
 */
export interface Verdict {
  decision: "approved" | "changes-requested" | "commented";
  summary: string;
  lenses: LensReport[];
  /** Additive round-progress signal for autonomous review loops (sage#107). */
  convergence?: ConvergenceSummary;
}
