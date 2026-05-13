import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

const FOCUS = `Look at this PR through a security lens. You care about: input validation at
trust boundaries (user input, network, DB), authentication & session handling,
secret handling (no hardcoded keys, env-var allow-lists respected), injection
surfaces (SQL, command, prompt), authorization checks (role/principal scope
enforced before action), and crypto correctness (modern primitives, no
home-rolled). You do NOT look for code style, performance, or architecture —
those belong to other lenses.

Flag a finding only when there is a concrete attack path or a clear violation
of a documented security invariant. "Could be better" alone is not enough.`;

export async function reviewSecurity(input: LensRunInput): Promise<LensReport> {
  return runLens({ name: "Security", focus: FOCUS }, input);
}
