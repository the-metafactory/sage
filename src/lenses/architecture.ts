import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

const FOCUS = `Look at this PR through an architecture lens. You care about: module
boundaries (does the new code belong where it lives?), separation of concerns
(does one module take on too many responsibilities?), dependency direction
(do low-level modules import from high-level ones?), public-surface shape
(are exported types and functions cohesive?), and forward-compatibility
(does this change paint future work into a corner?). You do NOT look for
correctness, security, or performance — those belong to other lenses.

Flag only when one of these concrete triggers applies:
- a documented principle in CLAUDE.md, ISA.md, or design docs is violated and
  you can quote it;
- the change makes a near-term feature impossible without rework; or
- the change is irreversible, such as schema migration or public API surface.

Single-consumer abstraction splits, helper density, and "could be more
cohesive" are not findings by themselves.`;

export async function reviewArchitecture(input: LensRunInput): Promise<LensReport> {
  return runLens({ name: "Architecture", focus: FOCUS }, input);
}
