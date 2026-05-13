import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

const FOCUS = `Look at this PR through a maintainability lens. You care about: duplication
(same logic copy-pasted or near-copied across the diff, especially across new
files), function size (functions whose body is large enough that a reader has
to scroll to keep state), nesting depth (deeply indented branches that hint at
extractable helpers), cyclomatic complexity (too many branches/loops piled
into one function), parameter count (six+ positional params signals a missing
struct), inappropriate abstraction (single-callsite helpers, premature
factories, "manager" / "util" dumping grounds), and dead code introduced by
the diff (unused exports, unreachable branches).

You do NOT look for correctness bugs, security holes, module boundary
violations, ecosystem-config issues, or hot-path performance — those belong
to the other lenses.

Flag a finding when readability or future-change-cost is materially worse
than the obvious refactor. Be concrete: name the function or the duplicated
block; suggest the extraction or the de-duplication target. Severity is
earned: a 90-line function with one extract opportunity is "suggestion", not
"blocker". Pure size without a clear refactor is rarely worth flagging — find
the duplication or the extractable shape, not the line count.`;

export async function reviewMaintainability(input: LensRunInput): Promise<LensReport> {
  return runLens({ name: "Maintainability", focus: FOCUS }, input);
}
