export type Severity = "blocker" | "important" | "suggestion" | "nit";

export interface Finding {
  /** File path relative to repo root. */
  path: string;
  /** 1-indexed line number in the new revision. Use 0 for file-level findings. */
  line: number;
  severity: Severity;
  title: string;
  rationale: string;
  /** Optional suggested patch (small inline replacement). */
  suggestion?: string;
}

export interface LensReport {
  lens: string;
  summary: string;
  findings: Finding[];
  durationMs: number;
  /**
   * True when the lens failed to execute (runtime throw, substrate
   * unavailable). The accompanying `findings` typically carry a single
   * synthesized `important` entry describing the failure mode, but the
   * absence of real findings is the load-bearing fact — the verdict must
   * not approve a PR whose lenses didn't actually run.
   *
   * Optional / omitted on the success path so the on-disk verdict JSON
   * for clean reviews stays byte-identical to pre-#26 output.
   */
  errored?: boolean;
}

export interface ReviewVerdict {
  decision: "approved" | "changes-requested" | "commented";
  summary: string;
  lenses: LensReport[];
}

export function decideVerdict(lenses: LensReport[]): ReviewVerdict {
  const all = lenses.flatMap((l) => l.findings);
  const hasBlocker = all.some((f) => f.severity === "blocker");
  const hasImportant = all.some((f) => f.severity === "important");
  // A lens that errored before producing findings is itself a merge-
  // blocker: we don't know what the lens would have flagged, so the
  // verdict must not approve. Per Holly review of sage#27 (findings #1
  // and #2): a silently-crashed Security lens should not render as a
  // mergable "commented" verdict next to five clean reports.
  const erroredLenses = lenses.filter((l) => l.errored);
  const hasLensError = erroredLenses.length > 0;

  // blocker, important, and lens-error all signal "fix before merge"
  // per persona.md §5 / Holly review. suggestion/nit are comment-only.
  const decision: ReviewVerdict["decision"] =
    hasBlocker || hasImportant || hasLensError
      ? "changes-requested"
      : all.length === 0
        ? "approved"
        : "commented";

  const summary = buildVerdictSummary(all, erroredLenses);

  return { decision, summary, lenses };
}

function buildVerdictSummary(all: Finding[], errored: LensReport[]): string {
  if (errored.length === 0) {
    return all.length === 0
      ? "No findings. Sage approves."
      : `${all.length} finding(s): ${countBySeverity(all)}.`;
  }
  const erroredNames = errored.map((l) => l.lens).join(", ");
  const erroredClause = `${errored.length} lens(es) failed to run: ${erroredNames}`;
  if (all.length === 0) return `${erroredClause}.`;
  return `${all.length} finding(s): ${countBySeverity(all)}; ${erroredClause}.`;
}

function countBySeverity(findings: Finding[]): string {
  const counts = findings.reduce<Record<Severity, number>>(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    },
    { blocker: 0, important: 0, suggestion: 0, nit: 0 },
  );
  return (Object.entries(counts) as [Severity, number][])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}
