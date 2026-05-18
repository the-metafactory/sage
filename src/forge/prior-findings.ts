/**
 * Forge-agnostic markdown parser for Sage's rendered review body.
 *
 * The rendered review format is single-source-of-truth — sage
 * generates the same markdown shape for GitHub PR review bodies,
 * GitLab MR notes, and any future forge. The parser that reads
 * prior findings back off a previous review therefore belongs HERE,
 * not inside a per-forge backend (sage review on #48, Architecture
 * lens — the GitLab backend importing from `forge/github` codified
 * the wrong dependency direction and would force any third forge
 * backend to depend on GitHub).
 *
 * Per-forge backends call `parseSageReviewFindings` against
 * `body` strings already extracted from forge-specific review /
 * note payload shapes. The mapping from forge JSON to body string
 * stays in each backend; the parsing of that string stays here.
 */

import type { PriorReviewFinding } from "./types.ts";

const PRIOR_FINDING_RE =
  /^- \*\*\[(blocker|important|suggestion|nit)\]\*\* `([^`]+):(\d+)` — \*\*([^*]+)\*\*/gm;

const REVIEW_HEADING_MARKER = "## Sage code review";

export function parseSageReviewFindings(body: string): PriorReviewFinding[] {
  if (!body.includes(REVIEW_HEADING_MARKER)) return [];

  const findings: PriorReviewFinding[] = [];
  for (const match of body.matchAll(PRIOR_FINDING_RE)) {
    const [, severity, path, line, title] = match;
    if (!severity || !path || !line || !title) continue;
    findings.push({
      path,
      line: Number(line),
      severity: severity as PriorReviewFinding["severity"],
      title: title.trim(),
    });
  }
  return findings;
}
