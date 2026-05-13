import { prView, prDiff, postReview, type PrRef, type ReviewEvent } from "../github/gh.ts";
import type { Substrate } from "../substrate/types.ts";
import { persistVerdict } from "../util/persistence.ts";
import { LENSES } from "./registry.ts";
import { decideVerdict, type ReviewVerdict, type LensReport } from "./types.ts";

export interface ReviewOptions {
  ref: PrRef;
  /**
   * Substrate that backs every lens for this review. Resolved once per
   * process at startup by the CLI / daemon (`selectSubstrate`) — Sage
   * deliberately does NOT support per-task substrate selection so verdicts
   * stay reproducible across operators. See issue #14 "Out of scope".
   */
  substrate: Substrate;
  /** Post the review back to GitHub via gh CLI. Default: false (dry-run). */
  post?: boolean;
  /** Per-lens substrate timeout. Falls back to substrate-specific default. */
  timeoutMs?: number;
  /** Progress callback fired after each lens completes — used for envelope emission in serve mode. */
  onLensComplete?: (report: LensReport) => void | Promise<void>;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  /**
   * True only when `opts.post` was set AND `postReview` actually returned
   * without throwing. Was previously `opts.post === true` (intent, not
   * outcome) — the lens-completion path published the verdict envelope
   * with `posted: true` even when the GH `gh pr review` call had crashed
   * silently. See sage#16.
   */
  posted: boolean;
  /**
   * Set when GH blocked self-{approve,request-changes} and postReview fell
   * back to `--comment`. The verdict.decision is unchanged — only the
   * GitHub-side event surface was downgraded. Undefined when post was
   * skipped or the original event was accepted.
   */
  postedEvent?: ReviewEvent;
  downgraded?: boolean;
  /**
   * Set when `opts.post` was true but `postReview` threw. The lens work
   * itself succeeded — the verdict is on disk via `persistVerdict` and
   * the caller can re-post manually. Bridge mode publishes a separate
   * `code.pr.review.post-failed` envelope so operators can distinguish
   * a post failure from a lens / dispatch failure (sage#16).
   */
  postError?: Error;
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
    const report = await lens.review({ pr, diff, substrate: opts.substrate, ...timeout });
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
  const body = renderReviewBody(verdict, opts.substrate.displayName);

  // Persist the verdict + rendered body BEFORE the network call. If
  // `postReview` fails permanently, the operator can re-post from disk
  // without re-running the lenses. The file at
  // ~/.config/sage/reviews/<owner>-<repo>-<pr>.{json,md} holds the latest
  // verdict per PR; older ones are overwritten on next run.
  persistVerdict(opts.ref, verdict, body);

  let postedEvent: ReviewEvent | undefined;
  let downgraded: boolean | undefined;
  let postError: Error | undefined;
  let posted = false;

  if (opts.post) {
    const target = `${opts.ref.owner}/${opts.ref.repo}#${opts.ref.number}`;
    // eslint-disable-next-line no-console
    console.error(
      `[workflow] post: attempting ${target} (decision=${verdict.decision})`,
    );
    try {
      const result = await postReview({
        ref: opts.ref,
        event: verdictToEvent(verdict.decision),
        body,
      });
      postedEvent = result.posted;
      downgraded = result.downgraded;
      posted = true;
      // eslint-disable-next-line no-console
      console.error(
        `[workflow] post: ok ${target} (event=${postedEvent}, downgraded=${downgraded})`,
      );
    } catch (err) {
      // Do NOT re-throw — pre-#16, a `postReview` throw escaped here and
      // landed in the bridge's outer try/catch, kicking the whole task to
      // `dispatch.task.failed`. That conflated a post failure with a lens
      // failure and discarded the (otherwise-valid) verdict. Now the
      // verdict is preserved on disk (above) and signaled to the caller
      // via `postError`; bridge mode publishes a dedicated
      // `code.pr.review.post-failed` envelope so operators can act on the
      // partial outcome without the lens work being lost.
      postError = err instanceof Error ? err : new Error(String(err));
      // eslint-disable-next-line no-console
      console.error(`[workflow] post: failed ${target}: ${postError.message}`);
    }
  }

  return {
    verdict,
    posted,
    ...(postedEvent !== undefined ? { postedEvent } : {}),
    ...(downgraded !== undefined ? { downgraded } : {}),
    ...(postError !== undefined ? { postError } : {}),
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

export function renderReviewBody(verdict: ReviewVerdict, substrateLabel?: string): string {
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
  const footer = `\n---\n_Posted by Sage on ${substrateLabel ?? "pi.dev"} substrate._`;
  return [head, ...sections, footer].join("\n\n");
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
