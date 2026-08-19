import type { ReviewEvent } from "../forge/types.ts";
import type { Finding, LensReport, Severity } from "../lenses/types.ts";
import type { Verdict } from "./types.ts";
import { summarizeConvergence } from "./convergence.ts";
import { normalizeTitle } from "./title.ts";

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
  const dedupedLenses = capPreviousRoundProse(dedupeLensFindings(lenses));
  const all = dedupedLenses.flatMap((l) => l.findings);
  const hasBlocker = all.some((f) => f.severity === "blocker");
  // sage#107 — the merge gate reads Finding impact, not severity alone. An
  // `important` Finding blocks only when addressing it would change runtime
  // behavior or a check's ability to fail. One that changes only wording does
  // not: on seekolous#199 the code settled at round 5 and the loop still ran to
  // round 20, because each round produced one reworded `important` and
  // `important` alone was enough to return changes-requested.
  //
  // `blocker` is deliberately NOT impact-gated — see `blocksAtImpact`.
  const hasBlockingImportant = all.some(
    (f) => f.severity === "important" && blocksAtImpact(f),
  );
  // A lens that errored before producing findings is itself a merge-
  // blocker: we don't know what the lens would have flagged, so the
  // verdict must not approve. Per Holly review of sage#27 (findings #1
  // and #2): a silently-crashed Security lens should not render as a
  // mergable "commented" verdict next to five clean reports.
  const erroredLenses = lenses.filter((l) => l.errored);
  const hasLensError = erroredLenses.length > 0;

  // blocker, behavior/check-impact important, and lens-error all signal
  // "fix before merge" per persona.md §5 / Holly review. suggestion, nit, and
  // wording-only important are comment-only.
  const decision: Verdict["decision"] =
    hasBlocker || hasBlockingImportant || hasLensError
      ? "changes-requested"
      : all.length === 0
        ? "approved"
        : "commented";

  const summary = buildVerdictSummary(all, erroredLenses);

  return {
    decision,
    summary,
    lenses: dedupedLenses,
    convergence: summarizeConvergence(dedupedLenses),
  };
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

/**
 * Whether an `important` Finding is severe enough to block merge, given what
 * addressing it would actually change.
 *
 * An unclassified impact reads as blocking. `impactFallback` marks a Finding
 * whose impact Sage defaulted because the model omitted it or emitted garbage
 * (see `normalizeImpact`); treating that as `prose` would let a substrate that
 * has not learned the field quietly open the merge gate. Same conservative
 * direction `summarizeConvergence` takes when it counts those into `behavior`.
 */
function blocksAtImpact(finding: Finding): boolean {
  if (finding.impactFallback || !finding.impact) return true;
  return finding.impact !== "prose";
}

/**
 * Severities the previous-round prose cap may lower. `blocker` is absent on
 * purpose — see `capPreviousRoundProse`.
 */
const PROSE_CAP_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "important",
  "suggestion",
]);

/**
 * sage#107 — de-prioritize the review surface Sage generated itself.
 *
 * A Finding carrying `previousRoundSurface` sits on a line the reviewee added
 * *after* Sage's last review, which in a review loop overwhelmingly means it is
 * text written to answer Sage. When that text also changes nothing but wording,
 * raising it above `nit` closes a reinforcing loop: Sage raises a Finding, the
 * reviewee explains the fix in a comment, that comment enters the diff, and the
 * next round Sage reviews the explanation. On seekolous#199 the review surface
 * inverted to roughly three parts prose to one part code by round 9.
 *
 * Scope, stated precisely so this is not read as more than it is:
 *
 *   - This NEVER changes a Verdict's decision. Prose-impact `important` already
 *     stops blocking via `blocksAtImpact`, and `blocker` is excluded here. What
 *     it changes is the Severity the reviewee SEES, so a round is not spent
 *     rewording something that was never going to block.
 *   - `blocker` is untouched. sage#107 warned against a round cap precisely
 *     because round 12 of that PR found a real defect in round 11's fix; a
 *     misleading claim in freshly-written prose is the same class of thing.
 *   - `behavior` and `check` impact are untouched at every Severity. A fix that
 *     broke something, or a regression test that can no longer fail, still
 *     reads at full Severity on previous-round surface.
 *   - An unclassified impact is untouched, for the same reason `blocksAtImpact`
 *     treats it as blocking.
 *
 * When the prior-round comparison could not be fetched, no Finding carries
 * `previousRoundSurface` and the cap simply does not fire — the fail-closed
 * direction, matching `previousRoundSurfaceUnavailable`.
 */
function capPreviousRoundProse(lenses: LensReport[]): LensReport[] {
  return lenses.map((lens) => ({
    ...lens,
    findings: lens.findings.map((finding) => {
      if (!finding.previousRoundSurface) return finding;
      if (finding.impactFallback || finding.impact !== "prose") return finding;
      if (!PROSE_CAP_SEVERITIES.has(finding.severity)) return finding;
      return { ...finding, severity: "nit" as const };
    }),
  }));
}

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
