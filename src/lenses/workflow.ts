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
   * `dispatch.task.post-failed` envelope so operators can distinguish a
   * post failure from a lens / dispatch failure (sage#16).
   *
   * Structured (not `Error`) so it can cross the NATS bus boundary
   * without serialization gymnastics and so future fields (`code`,
   * `retryable`, …) can be added without a breaking change to
   * `ReviewResult`.
   */
  postError?: PostError;
}

/**
 * Structured shape for a post-step failure. Crosses process boundaries
 * via the bus, so the contract is plain JSON-shaped data — no `Error`
 * prototype, no stack trace (which leaks file paths from the daemon's
 * filesystem).
 */
export interface PostError {
  /**
   * Operator-facing error message. Truncated to `POST_ERROR_MAX_LEN` to
   * cap blast radius if `gh`'s stderr ever echoes unexpected content
   * (the rejection message in `runGh` embeds the subprocess stderr
   * verbatim).
   */
  message: string;
}

/**
 * Cap on UTF-16 characters of `gh` stderr that ride the post-failed
 * envelope. 500 is enough to surface a typical `gh pr review` failure
 * (auth message, HTTP status + body snippet) without becoming a vector
 * for stderr-stuffing if the subprocess crashes mid-output.
 *
 * @internal Exported for the truncation test; not part of the supported
 * API surface.
 */
export const POST_ERROR_MAX_LEN = 500;

/**
 * Strip control bytes and ANSI escape sequences from a string. `gh`'s
 * stderr can include color codes and (theoretically) attacker-shaped
 * content reflected from a remote repository's name or PR body; we
 * sanitize before the message rides the NATS bus or hits an operator's
 * terminal via `console.error`.
 *
 *   - `\x00-\x08` + `\x0b-\x1f` + `\x7f`: C0 control bytes except
 *     `\t` (`\x09`) and `\n` (`\x0a`), which are useful in error
 *     dumps.
 *   - `\x1b\[[0-9;]*[A-Za-z]`: CSI ANSI escape sequences (the most
 *     common terminal-injection vector).
 */
function sanitizeErrorMessage(raw: string): string {
  // ORDER MATTERS: alternation is left-to-right at each position, so the
  // CSI pattern must come BEFORE the control-byte class — otherwise the
  // engine consumes `\x1b` as a single control byte (which it is) before
  // the CSI pattern gets a chance to match `\x1b[31m` as a unit, leaving
  // a visible `[31m` orphan in the output.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-9;]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g, "");
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

  const { posted, postedEvent, downgraded, postError } = opts.post
    ? await attemptPost(opts.ref, verdict, body)
    : { posted: false };
  return {
    verdict,
    posted,
    ...(postedEvent !== undefined ? { postedEvent } : {}),
    ...(downgraded !== undefined ? { downgraded } : {}),
    ...(postError !== undefined ? { postError } : {}),
  };
}

interface AttemptPostResult {
  posted: boolean;
  postedEvent?: ReviewEvent;
  downgraded?: boolean;
  postError?: PostError;
}

/**
 * Attempt the GitHub post step. Pure helper extracted from `reviewPr` so
 * the data flow is explicit (return value, not four outer-scope mutations)
 * and `reviewPr` stays scannable (sage#16 round-2 review).
 *
 * Never re-throws — pre-#16, a `postReview` throw escaped out of
 * `reviewPr` and landed in the bridge's outer try/catch, kicking the
 * whole task to `dispatch.task.failed`. That conflated a post failure
 * with a lens failure and discarded the (otherwise-valid) verdict. Now
 * the verdict is preserved on disk by the caller before this is invoked,
 * and the captured error is surfaced via `postError`; bridge mode
 * publishes a dedicated `dispatch.task.post-failed` envelope (sibling of
 * `failed` in the lifecycle namespace) so operators can act on the
 * partial outcome without the lens work being lost.
 */
async function attemptPost(
  ref: PrRef,
  verdict: ReviewVerdict,
  body: string,
): Promise<AttemptPostResult> {
  const target = `${ref.owner}/${ref.repo}#${ref.number}`;
  // eslint-disable-next-line no-console
  console.error(`[workflow] post: attempting ${target} (decision=${verdict.decision})`);

  try {
    const result = await postReview({
      ref,
      event: verdictToEvent(verdict.decision),
      body,
    });
    // eslint-disable-next-line no-console
    console.error(
      `[workflow] post: ok ${target} (event=${result.posted}, downgraded=${result.downgraded})`,
    );
    return {
      posted: true,
      postedEvent: result.posted,
      downgraded: result.downgraded,
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    // Sanitize BEFORE truncate so control bytes / ANSI escapes can't
    // partially-survive past the slice boundary. The sanitized string
    // is the one that rides the bus AND the one operators see in their
    // terminal, so the same hygiene applies in both directions.
    const sanitized = sanitizeErrorMessage(rawMessage);
    const message =
      sanitized.length > POST_ERROR_MAX_LEN
        ? `${sanitized.slice(0, POST_ERROR_MAX_LEN)} […truncated ${sanitized.length - POST_ERROR_MAX_LEN} chars]`
        : sanitized;
    // eslint-disable-next-line no-console
    console.error(`[workflow] post: failed ${target}: ${message}`);
    return { posted: false, postError: { message } };
  }
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
