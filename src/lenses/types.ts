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
  /** Lenses that raised this finding before cross-lens deduplication. */
  sourceLenses?: string[];
}

export interface LensReport {
  lens: string;
  summary: string;
  findings: Finding[];
  durationMs: number;
  /**
   * True when the lens failed to execute — runtime throw, substrate
   * unavailable, or model output unparseable as JSON. The accompanying
   * `findings` carry a single synthesized `important` entry describing
   * the failure mode, but the absence of real findings is the load-
   * bearing fact: the verdict must not approve a PR whose lenses didn't
   * actually run.
   *
   * Bus contract — this `LensReport` shape rides NATS via
   * `onLensComplete` → bridge → `dispatch.task.progress` (lens-level)
   * and is embedded in the final `code.pr.review.*` verdict envelope.
   * Downstream consumers fall into two categories:
   *
   *   - **trustworthiness-aware** (cortex dashboard verdict trust scoring,
   *     pilot-loop retry decisions, audit log): SHOULD branch on
   *     `errored` to distinguish "lens ran, found nothing" from "lens
   *     never ran"
   *   - **severity-only** (rendering, merge-gate counters): MAY ignore
   *     the flag — the synthesized `important` finding ensures their
   *     existing severity-based logic still flags merge-block via
   *     `decideVerdict`
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

/**
 * Construct an errored `LensReport`. Used at both synthesis sites:
 *
 *   - `runLens` (src/lenses/base.ts) — substrate-fallback path; the
 *     lens's substrate.runJson threw or the model output couldn't be
 *     parsed. `source: "output"`.
 *   - `reviewPr` (src/lenses/workflow.ts) — inline-catch path; the
 *     lens implementation bypassed `runLens` and threw directly.
 *     `source: "runtime"`.
 *
 * Sharing the constructor keeps the `errored: true` contract
 * byte-stable across both sites — pre-extraction the two sites
 * carried slightly different summary strings (Holly review of sage#27
 * round 3, finding #2), which made the rendered review body look
 * inconsistent depending on which path failed.
 */
export interface ErroredLensReportInput {
  lens: string;
  rationale: string;
  durationMs: number;
  /**
   * Where the failure surfaced. `runtime` → lens-level throw (the
   * lens implementation itself crashed). `output` → substrate-level
   * fallback (the substrate ran but didn't produce a usable verdict).
   * Only affects the diagnostic finding's `path` and `title` —
   * everything else is identical between the two paths so the verdict
   * gate, renderer, and bus contract all behave the same.
   */
  source: "runtime" | "output";
}

export function buildErroredLensReport(opts: ErroredLensReportInput): LensReport {
  const isRuntime = opts.source === "runtime";
  return {
    lens: opts.lens,
    summary: `Lens "${opts.lens}" did not produce a usable verdict; verdict cannot rely on this lens.`,
    findings: [
      {
        path: isRuntime ? "(lens runtime)" : "(lens output)",
        line: 0,
        severity: "important",
        title: isRuntime
          ? `${opts.lens}: lens runtime error`
          : `${opts.lens}: model deviated from JSON contract`,
        rationale: opts.rationale,
      },
    ],
    durationMs: opts.durationMs,
    errored: true,
  };
}

export function decideVerdict(lenses: LensReport[]): ReviewVerdict {
  const dedupedLenses = dedupeLensFindings(lenses);
  const all = dedupedLenses.flatMap((l) => l.findings);
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

  return { decision, summary, lenses: dedupedLenses };
}

const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 4,
  important: 3,
  suggestion: 2,
  nit: 1,
};

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export function dedupeLensFindings(lenses: LensReport[]): LensReport[] {
  const deduped = lenses.map((lens) => ({ ...lens, findings: [] as Finding[] }));
  const firstIndexByKey = new Map<string, { lensIndex: number; findingIndex: number }>();

  lenses.forEach((lens, lensIndex) => {
    lens.findings.forEach((finding) => {
      if (lens.errored) {
        deduped[lensIndex]?.findings.push(finding);
        return;
      }

      const key = findingDedupKey(finding);
      const existingRef = firstIndexByKey.get(key);
      if (!existingRef) {
        firstIndexByKey.set(key, {
          lensIndex,
          findingIndex: deduped[lensIndex]?.findings.length ?? 0,
        });
        deduped[lensIndex]?.findings.push({
          ...finding,
          sourceLenses: mergeSourceLenses(finding.sourceLenses, lens.lens),
        });
        return;
      }

      const existing = deduped[existingRef.lensIndex]?.findings[existingRef.findingIndex];
      if (!existing) return;
      const merged = mergeFindings(existing, finding, lens.lens);
      deduped[existingRef.lensIndex]!.findings[existingRef.findingIndex] = merged;
    });
  });

  lenses.forEach((lens, lensIndex) => {
    const output = deduped[lensIndex];
    if (!output || lens.errored) return;
    if (lens.findings.length > 0 && output.findings.length === 0) {
      output.summary = "Findings deduplicated into earlier lens sections.";
    }
  });

  return deduped;
}

function mergeFindings(existing: Finding, incoming: Finding, lensName: string): Finding {
  const keepIncoming = SEVERITY_RANK[incoming.severity] > SEVERITY_RANK[existing.severity];
  const sourceLenses = mergeSourceLenses(existing.sourceLenses, lensName);
  if (!keepIncoming) return { ...existing, sourceLenses };
  return {
    ...incoming,
    sourceLenses,
  };
}

function mergeSourceLenses(existing: string[] | undefined, lensName: string): string[] {
  const merged = [...(existing ?? []), lensName];
  return [...new Set(merged)];
}

function findingDedupKey(finding: Finding): string {
  return `${finding.path}:${finding.line}:${normalizeTitle(finding.title)}`;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !TITLE_STOP_WORDS.has(word))
    .join(" ");
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
