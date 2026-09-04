import { renderVerdict, type Verdict } from "./verdict/index.ts";
import { renderReviewedCommitMarker } from "./util/review-commit.ts";

/** Render the Forge-facing Review comment, including Review provenance. */
export function renderReviewComment(
  verdict: Verdict,
  substrateLabel: string | undefined,
  reviewedCommitId: string | undefined,
): string {
  const verdictBody = renderVerdict(verdict, substrateLabel);
  const provenance = reviewedCommitId
    ? renderReviewedCommitMarker(reviewedCommitId)
    : undefined;
  return provenance ? `${verdictBody}\n${provenance}` : verdictBody;
}
