import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

const FOCUS = `Review this PR through the CodeQuality lens. Focus on correctness, clarity,
error handling, edge cases, and idiomatic style. Surface only real issues —
do not invent findings. You do NOT look for security, architecture,
ecosystem compliance, or performance — those belong to other lenses.`;

export async function reviewCodeQuality(input: LensRunInput): Promise<LensReport> {
  return runLens({ name: "CodeQuality", focus: FOCUS }, input);
}
