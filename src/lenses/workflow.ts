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
  // Progress callbacks (e.g., NATS publish in daemon mode) are non-critical
  // — a publish failure must not discard a completed review. Log and move on.
  try {
    await opts.onLensComplete?.(cq);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[sage] onLensComplete (CodeQuality) failed: ${m}`);
  }

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
            .map((f) => {
              const findingHead = `- **[${f.severity}]** \`${f.path}:${f.line}\` — **${f.title}**\n  ${f.rationale}`;
              if (!f.suggestion) return findingHead;
              const fence = pickFence(f.suggestion);
              return `${findingHead}\n  \n  Suggestion:\n\n  ${fence}\n  ${f.suggestion.replace(/\n/g, "\n  ")}\n  ${fence}`;
            })
            .join("\n\n");
    return `### ${lens.lens}\n${lens.summary}\n\n${body}`;
  });
  return [head, ...sections, "\n---\n_Posted by Sage on pi.dev substrate._"].join("\n\n");
}

/**
 * Pick a code-fence delimiter longer than any run of backticks inside the
 * content. Prevents triple-backtick injection when an LLM-supplied
 * `suggestion` contains its own fenced code block.
 */
function pickFence(content: string): string {
  let maxRun = 0;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length > maxRun) maxRun = m[0].length;
  }
  return "`".repeat(Math.max(3, maxRun + 1));
}
