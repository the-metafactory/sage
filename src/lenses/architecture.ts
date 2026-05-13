import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

const FOCUS = `Look at this PR through an architecture lens. You care about: module
boundaries (does the new code belong where it lives?), separation of concerns
(does one module take on too many responsibilities?), dependency direction
(do low-level modules import from high-level ones?), public-surface shape
(are exported types and functions cohesive?), and forward-compatibility
(does this change paint future work into a corner?). You do NOT look for
correctness, security, or performance — those belong to other lenses.

Flag a finding when a structural decision is likely to cost rework later, or
when the change violates a stated architectural principle in the repo's
docs (CLAUDE.md, ISA.md, design docs).`;

export async function reviewArchitecture(input: LensRunInput): Promise<LensReport> {
  return runLens({ name: "Architecture", focus: FOCUS }, input);
}
