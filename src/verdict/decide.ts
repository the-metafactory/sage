import type { ReviewEvent } from "../forge/types.ts";
import type { Finding, LensReport, Severity } from "../lenses/types.ts";
import type { Verdict } from "./types.ts";

/**
 * Decide a Verdict from a set of LensReports. Owns:
 *   - cross-lens Finding deduplication (sage#32)
 *   - the severity → decision matrix (Holly review of sage#27)
 *   - the operator-facing summary string
 *
 * Pure function. No I/O, no Substrate, no Forge. Substrate-independent
 * by principle — the same lenses must produce the same Verdict
 * regardless of which Substrate ran them.
 */
export function decideVerdict(lenses: LensReport[]): Verdict {
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
  const decision: Verdict["decision"] =
    hasBlocker || hasImportant || hasLensError
      ? "changes-requested"
      : all.length === 0
        ? "approved"
        : "commented";

  const summary = buildVerdictSummary(all, erroredLenses);

  return { decision, summary, lenses: dedupedLenses };
}

/**
 * Map a Verdict's decision to the Forge-API `ReviewEvent` enum. The
 * mapping is the one direction Verdict → Forge crosses; the reverse
 * never happens. Kept here (alongside `decideVerdict`) because the
 * conversion operates on a Verdict's decision field — it is
 * verdict-domain logic, not Forge-domain logic.
 *
 * Naming note: returns `ReviewEvent` because the codebase still uses
 * that name. CONTEXT.md's canonical term is `PostAction`; the full
 * codebase rename is deferred (see decisions.md 2026-05-21).
 */
export function verdictToEvent(decision: Verdict["decision"]): ReviewEvent {
  switch (decision) {
    case "approved":
      return "approve";
    case "changes-requested":
      return "request-changes";
    case "commented":
    default:
      return "comment";
  }
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

/**
 * Cross-lens Finding dedup (sage#32). Findings matching on
 * `path:line:normalized-title` collapse into the earliest lens that
 * raised them; later lenses get their finding moved into the earlier
 * section with `sourceLenses` carrying the attribution. Errored
 * lenses are skipped — their synthesized diagnostic must stay
 * attached to the errored lens.
 *
 * Internal to the Verdict Module — not re-exported. Callers go
 * through `decideVerdict`.
 */
function dedupeLensFindings(lenses: LensReport[]): LensReport[] {
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
