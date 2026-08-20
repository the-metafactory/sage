/**
 * Prior Findings Module — `createPriorFindings`.
 *
 * Composes a `PriorFindings` Interface from a `ForgeReviewSource` Port.
 * Owns:
 *   1. Trust gating (only reviews authored by the resolved Sage
 *      identity count).
 *   2. Parsing via the forge-agnostic markdown grammar
 *      (`parseSageReviewFindings` in `src/forge/prior-findings.ts`).
 *   3. Dedup by `path:line:severity:title` across the trusted review
 *      bodies, preserving the Adapter's oldest-first order.
 *   4. Enrichment: each parsed Finding gains `postedAt` from the
 *      review it came from (additive — `lensClass` stays undefined
 *      until the parser learns the heading grammar; the field is on
 *      `PriorReviewFinding` so future enrichment is data-only).
 *
 * Never throws: every failure mode resolves to a `PriorFindingsResult`
 * with a non-`ok` status and a human-readable reason. Workflow callers
 * forward `status !== "ok"` onto the Lifecycle envelope via
 * `onPriorFindingsDegraded`.
 */

import {
  isSageRenderedReview,
  parseSageCheckedClaims,
  parseSageReviewedCommit,
  parseSageReviewFindings,
} from "../forge/prior-findings.ts";
import type { PrRef, PriorReviewFinding } from "../forge/types.ts";
import type {
  ForgeReviewSource,
  PriorFindings,
  PriorFindingsResult,
} from "./types.ts";

export function createPriorFindings(source: ForgeReviewSource): PriorFindings {
  return {
    async collect(ref: PrRef): Promise<PriorFindingsResult> {
      let raw;
      try {
        raw = await source.fetchReviewBodies(ref);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: "source-failed",
          findings: [],
          reviewCount: 0,
          reason: message,
        };
      }

      if (raw.sageLogin === null) {
        return {
          status: "trust-gate-failed",
          findings: [],
          reviewCount: 0,
          reason:
            "Sage identity could not be resolved (SAGE_REVIEW_AUTHOR_LOGIN unset and forge user-API call failed)",
        };
      }

      const sageLogin = raw.sageLogin;
      const seen = new Set<string>();
      const findings: PriorReviewFinding[] = [];
      let latestReviewCommitId: string | undefined;
      let latestReviewCommitPostedAt: string | undefined;
      let latestCheckedClaimsDigest: string | undefined;
      let reviewCount = 0;
      for (const review of raw.bodies) {
        if (review.authorLogin !== sageLogin) continue;
        if (!isSageRenderedReview(review.body)) continue;
        reviewCount++;
        // GitHub's non-Review records carry no native commit ID. New Sage Verdict
        // bodies record it in a forge-neutral marker; prefer the native field
        // when a formal Review supplies both.
        const reviewedCommit = review.commitId ?? parseSageReviewedCommit(review.body);
        if (reviewedCommit) {
          const hasTimestampTie =
            review.postedAt !== undefined && review.postedAt === latestReviewCommitPostedAt;
          if (hasTimestampTie && latestReviewCommitId !== reviewedCommit) {
            // GitHub timestamps are second-granular across distinct review and
            // discussion resources. Their relative order is unknowable, so do
            // not select an arbitrary delta baseline.
            latestReviewCommitId = undefined;
          } else {
            latestReviewCommitId = reviewedCommit;
          }
          latestReviewCommitPostedAt = review.postedAt;
        }
        // Last one wins, and only Reviews that recorded a digest update it: a
        // later Review whose Oracle did not run must not erase the fact that an
        // earlier one checked these claims.
        const checked = parseSageCheckedClaims(review.body);
        if (checked) latestCheckedClaimsDigest = checked;
        for (const finding of parseSageReviewFindings(review.body)) {
          const key = `${finding.path}:${finding.line}:${finding.severity}:${finding.title}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            ...finding,
            ...(review.postedAt !== undefined ? { postedAt: review.postedAt } : {}),
          });
        }
      }

      return {
        status: "ok",
        findings,
        reviewCount,
        identity: { login: sageLogin },
        ...(latestReviewCommitId !== undefined ? { latestReviewCommitId } : {}),
        ...(latestCheckedClaimsDigest !== undefined ? { latestCheckedClaimsDigest } : {}),
      };
    },
  };
}
