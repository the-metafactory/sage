import { prView, prDiff, postReview, type PrRef, type ReviewEvent } from "../github/gh.ts";
import { persistVerdict } from "../util/persistence.ts";
import { LENSES } from "./registry.ts";
import { decideVerdict, type ReviewVerdict, type LensReport } from "./types.ts";

export interface ReviewOptions {
  ref: PrRef;
  /** Post the review back to GitHub via gh CLI. Default: false (dry-run). */
  post?: boolean;
  /** Per-lens pi runner timeout. Falls back to `PI_TIMEOUT_MS` env or 10min. */
  timeoutMs?: number;
  /** Progress callback fired after each lens completes — used for envelope emission in serve mode. */
  onLensComplete?: (report: LensReport) => void | Promise<void>;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  posted: boolean;
  /**
   * Set when GH blocked self-{approve,request-changes} and postReview fell
   * back to `--comment`. The verdict.decision is unchanged — only the
   * GitHub-side event surface was downgraded. Undefined when post was
   * skipped or the original event was accepted.
   */
  postedEvent?: ReviewEvent;
  downgraded?: boolean;
}

export async function reviewPr(opts: ReviewOptions): Promise<ReviewResult> {
  const pr = await prView(opts.ref);
  const diff = await prDiff(opts.ref);

  const ctx = { pr, diff };
  const timeout = opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {};
  const lensReports: LensReport[] = [];

  // Iterate the declared lens registry. Each entry self-describes its
  // optional applicability predicate, so adding lens #6 is a single-file
  // edit in src/lenses/registry.ts — no changes here. Per cortex/docs/
  // design-pi-dev-review-agent.md §7.
  for (const lens of LENSES) {
    if (lens.applies && !lens.applies(ctx)) continue;
    const report = await lens.review({ pr, diff, ...timeout });
    lensReports.push(report);
    // Progress callbacks (e.g., NATS publish in daemon mode) are non-critical
    // — a publish failure must not discard a completed review. Log and move on.
    try {
      await opts.onLensComplete?.(report);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[workflow] onLensComplete (${report.lens}) failed: ${m}`);
    }
  }

  const verdict = decideVerdict(lensReports);
  const body = renderReviewBody(verdict);

  // Persist the verdict + rendered body BEFORE the network call. If postReview
  // fails permanently (network or otherwise), the operator can re-post from
  // disk without re-running the lenses. ~/.config/sage/reviews/<repo>-<pr>.json
  // holds the latest verdict per PR; older ones are overwritten on next run.
  persistVerdict(opts.ref, verdict, body);

  let postedEvent: ReviewEvent | undefined;
  let downgraded: boolean | undefined;
  if (opts.post) {
    const result = await postReview({
      ref: opts.ref,
      event: verdictToEvent(verdict.decision),
      body,
    });
    postedEvent = result.posted;
    downgraded = result.downgraded;
  }

  return {
    verdict,
    posted: opts.post === true,
    ...(postedEvent !== undefined ? { postedEvent } : {}),
    ...(downgraded !== undefined ? { downgraded } : {}),
  };
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
