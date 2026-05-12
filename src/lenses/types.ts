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

  const decision: ReviewVerdict["decision"] = hasBlocker
    ? "changes-requested"
    : hasImportant
      ? "commented"
      : all.length === 0
        ? "approved"
        : "commented";

  const summary =
    all.length === 0
      ? "No findings. Sage approves."
      : `${all.length} finding(s): ${countBySeverity(all)}.`;

  return { decision, summary, lenses };
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
