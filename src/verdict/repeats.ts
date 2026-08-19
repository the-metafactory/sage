import type { PriorReviewFinding } from "../forge/types.ts";
import type { LensReport } from "../lenses/types.ts";
import { titleTokens } from "./title.ts";

/**
 * Repeat detection across review rounds (sage#107).
 *
 * The lens prompt already asks each lens not to re-raise a Finding it raised on
 * an earlier round. That instruction is obeyed for verbatim repeats and walked
 * straight through by rephrasing: on seekolous#199 the per-round Finding count
 * never converged — 11, 10, 11, 10, 12, 10, 11 — while the code stopped moving
 * after round 5. A reworded restatement reads as new work to the reviewee, who
 * spends a round on it, and the loop keeps its own count honest-looking.
 *
 * This marks such a restatement instead of dropping it. Dropping would be the
 * cheaper-looking move and the wrong one: a Finding that repeats because nobody
 * fixed it is exactly the Finding that must keep reaching the Verdict. What is
 * removed is the appearance of NEWNESS, not the Finding.
 *
 * Scope after sage#111: `delta`-scoped lenses no longer re-read settled code,
 * so most of what this catches now comes from the three `cumulative`-scoped
 * lenses — Architecture, Maintainability and HonestOracle — which re-read the
 * whole change (and the whole PR description) every round by design.
 */

/**
 * Jaccard similarity over normalized title tokens, above which two Findings on
 * the same path are treated as the same Finding restated.
 *
 * 0.5 deliberately under-matches. A heavy paraphrase ("missing null guard on
 * user input" vs "user input lacks a null check" — 3 shared tokens out of 7)
 * scores below it and is reported as new. That is the safe direction for a
 * heuristic whose output is a LABEL on someone else's work: a missed repeat
 * costs one redundant Finding, while an over-eager matcher tells a reviewee
 * that genuinely new work is old news.
 */
const REPEAT_SIMILARITY = 0.5;

/** Titles shorter than this carry too little signal to match on. */
const MIN_TITLE_TOKENS = 2;

/**
 * Mark Findings that restate one Sage already raised on an earlier round of
 * this PR. Additive: no Finding is dropped, reordered, or re-severitied.
 *
 * Matching is by `path` plus title-token overlap. Line numbers are deliberately
 * NOT part of the key — the reviewee's fixes shift them every round, which is
 * what made the prompt-level "do not re-raise" instruction so easy to slip.
 */
export function markRepeatedFindings(
  lenses: readonly LensReport[],
  priorFindings: readonly PriorReviewFinding[],
): LensReport[] {
  if (priorFindings.length === 0) return lenses.map((lens) => ({ ...lens }));

  const priorByPath = new Map<string, { title: string; tokens: Set<string> }[]>();
  for (const prior of priorFindings) {
    const tokens = titleTokens(prior.title);
    if (tokens.size < MIN_TITLE_TOKENS) continue;
    const bucket = priorByPath.get(prior.path) ?? [];
    bucket.push({ title: prior.title, tokens });
    priorByPath.set(prior.path, bucket);
  }

  return lenses.map((lens) => {
    // An errored lens carries a synthesized diagnostic about Sage's own
    // plumbing, not something observed in the diff. "You raised this last round
    // too" is true of a lens that failed twice and is not the point anyone
    // needs made about it.
    if (lens.errored) return { ...lens };
    return {
      ...lens,
      findings: lens.findings.map((finding) => {
        const candidates = priorByPath.get(finding.path);
        if (!candidates) return finding;
        const tokens = titleTokens(finding.title);
        if (tokens.size < MIN_TITLE_TOKENS) return finding;
        const match = bestMatch(tokens, candidates);
        return match ? { ...finding, repeatOfPriorFinding: match } : finding;
      }),
    };
  });
}

function bestMatch(
  tokens: Set<string>,
  candidates: readonly { title: string; tokens: Set<string> }[],
): string | undefined {
  let best: { title: string; score: number } | undefined;
  for (const candidate of candidates) {
    const score = jaccard(tokens, candidate.tokens);
    if (score < REPEAT_SIMILARITY) continue;
    if (!best || score > best.score) best = { title: candidate.title, score };
  }
  return best?.title;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
