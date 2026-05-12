import { prView, prDiff, postReview, type PrRef, type ReviewEvent } from "../github/gh.ts";
import { reviewCodeQuality } from "./code-quality.ts";
import { decideVerdict, type ReviewVerdict, type LensReport } from "./types.ts";

export interface ReviewOptions {
  ref: PrRef;
  /** Post the review back to GitHub via gh CLI. Default: false (dry-run). */
  post?: boolean;
  /** Progress callback fired after each lens completes — used for envelope emission in serve mode. */
  onLensComplete?: (report: LensReport) => void | Promise<void>;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  posted: boolean;
}

export async function reviewPr(opts: ReviewOptions): Promise<ReviewResult> {
  const pr = await prView(opts.ref);
  const diff = await prDiff(opts.ref);

  const lensReports: LensReport[] = [];

  const cq = await reviewCodeQuality({ pr, diff });
  lensReports.push(cq);
  await opts.onLensComplete?.(cq);

  // Future lenses (Security, Architecture, EcosystemCompliance, Performance)
  // plug in here. Each becomes an additional report appended to lensReports.

  const verdict = decideVerdict(lensReports);

  if (opts.post) {
    await postReview({
      ref: opts.ref,
      event: verdictToEvent(verdict.decision),
      body: renderReviewBody(verdict),
    });
  }

  return { verdict, posted: opts.post === true };
}

function verdictToEvent(decision: ReviewVerdict["decision"]): ReviewEvent {
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

export function renderReviewBody(verdict: ReviewVerdict): string {
  const head = `## Sage code review — ${verdict.decision}\n\n${verdict.summary}\n`;
  const sections = verdict.lenses.map((lens) => {
    const body =
      lens.findings.length === 0
        ? "_No findings._"
        : lens.findings
            .map(
              (f) =>
                `- **[${f.severity}]** \`${f.path}:${f.line}\` — **${f.title}**\n  ${f.rationale}${
                  f.suggestion ? `\n  \n  Suggestion:\n  \`\`\`\n  ${f.suggestion}\n  \`\`\`` : ""
                }`,
            )
            .join("\n\n");
    return `### ${lens.lens}\n${lens.summary}\n\n${body}`;
  });
  return [head, ...sections, "\n---\n_Posted by Sage on pi.dev substrate._"].join("\n\n");
}
