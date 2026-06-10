import type { Severity } from "../lenses/types.ts";
import type { Verdict } from "./types.ts";

/**
 * Cortex verdict-block emission (sage#83).
 *
 * cortex's review-pipeline derives a verdict by scanning the reviewer's stdout
 * for the LAST fenced ```json block and validating it against a frozen contract
 * (`parseVerdictBlock`, cortex/src/runner/review-pipeline.ts). Sage's markdown
 * review body carries no such block, so the cortex `pi-dev` substrate path
 * falls back to exit-code-only mapping (exit 0 → commented), losing `approved`
 * and the findings counts. This module renders the contract block so cortex can
 * recover the real decision + counts.
 */

/**
 * Post-time metadata the structured block carries but the lens pipeline does
 * not produce. `commit_id` comes from the PR head; the GitHub review id/url +
 * `submitted_at` come from the posted review (or link-less defaults when the
 * review was not posted / the id could not be resolved).
 */
export interface VerdictBlockMeta {
  github_review_id: number;
  github_review_url: string;
  /** ISO 8601 timestamp the review was submitted. */
  submitted_at: string;
  /** PR head commit SHA. */
  commit_id: string;
  inline_comments: number;
}

/** cortex findings buckets. Narrower than Sage's 4-level severity scale. */
export interface FindingsBuckets {
  blockers: number;
  majors: number;
  nits: number;
}

/**
 * Map Sage's 4-level severity scale onto cortex's 3 findings buckets:
 *   blocker    → blockers
 *   important  → majors
 *   suggestion → nits
 *   nit        → nits
 *
 * Mirrors `decideVerdict`'s escalation tiers: blockers gate the verdict to
 * changes-requested, importants are majors worth surfacing, and the two
 * advisory tiers collapse into nits.
 */
export function mapFindingsToBuckets(verdict: Verdict): FindingsBuckets {
  const buckets: FindingsBuckets = { blockers: 0, majors: 0, nits: 0 };
  for (const lens of verdict.lenses) {
    for (const f of lens.findings) {
      buckets[bucketFor(f.severity)] += 1;
    }
  }
  return buckets;
}

function bucketFor(severity: Severity): keyof FindingsBuckets {
  switch (severity) {
    case "blocker":
      return "blockers";
    case "important":
      return "majors";
    case "suggestion":
    case "nit":
      return "nits";
  }
}

/**
 * Internal shape of the structured verdict block. Mirrors cortex's
 * `VerdictBlock` interface field-for-field — `parseVerdictBlock` validates
 * every field, so any drift here is caught by the round-trip contract test.
 */
interface VerdictBlockJson {
  verdict: Verdict["decision"];
  summary: string;
  github_review_id: number;
  github_review_url: string;
  submitted_at: string;
  commit_id: string;
  findings: FindingsBuckets;
  inline_comments: number;
}

/**
 * Render the cortex-contract structured verdict block as a fenced ```json
 * artefact. Pure + deterministic: same inputs → byte-identical output.
 *
 * cortex's `extractVerdictBlock` picks the LAST ```json fence in the
 * reviewer's stdout, so callers MUST append this as the terminal artefact
 * (after the human review body). `verdict.decision` already uses cortex's
 * enum (`approved | changes-requested | commented`) verbatim — no translation.
 */
export function renderVerdictBlock(verdict: Verdict, meta: VerdictBlockMeta): string {
  const block: VerdictBlockJson = {
    verdict: verdict.decision,
    summary: verdict.summary,
    github_review_id: meta.github_review_id,
    github_review_url: meta.github_review_url,
    submitted_at: meta.submitted_at,
    commit_id: meta.commit_id,
    findings: mapFindingsToBuckets(verdict),
    inline_comments: meta.inline_comments,
  };
  return ["```json", JSON.stringify(block, null, 2), "```"].join("\n");
}
