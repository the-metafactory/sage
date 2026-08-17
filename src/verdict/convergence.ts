import type { FindingImpact, LensReport } from "../lenses/types.ts";

export interface ConvergenceSummary {
  behavior: number;
  check: number;
  prose: number;
  /** Findings conservatively counted as behavior because impact was absent or invalid. */
  unclassifiedImpact: number;
  previousRoundSurface: number;
  coverageFailed: boolean;
  /** An automation-safe stopping signal: no behavior or check change remains. */
  status: "actionable" | "prose-only" | "clean";
}

/**
 * Classify the result of one review round by the work it asks for, not by
 * severity. Older lenses did not emit an impact; treating that output as
 * behavior preserves the conservative historical gate until every substrate
 * has learned the new JSON field. `unclassifiedImpact` keeps that fallback
 * visible to consumers, so it cannot masquerade as a genuine behavior count.
 */
export function summarizeConvergence(lenses: readonly LensReport[]): ConvergenceSummary {
  const counts: Record<FindingImpact, number> = { behavior: 0, check: 0, prose: 0 };
  let unclassifiedImpact = 0;
  let previousRoundSurface = 0;
  let coverageFailed = false;
  for (const lens of lenses) {
    if (lens.errored) coverageFailed = true;
    for (const finding of lens.findings) {
      if (finding.impactFallback || !finding.impact) {
        counts.behavior += 1;
        unclassifiedImpact++;
      } else {
        counts[finding.impact] += 1;
      }
      if (finding.previousRoundSurface) previousRoundSurface++;
    }
  }
  const status = coverageFailed || counts.behavior > 0 || counts.check > 0
    ? "actionable"
    : counts.prose > 0
      ? "prose-only"
      : "clean";
  return { ...counts, unclassifiedImpact, previousRoundSurface, coverageFailed, status };
}
