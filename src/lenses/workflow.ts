import { prView, prDiff, postReview, type PrRef, type ReviewEvent } from "../github/gh.ts";
import type { Substrate } from "../substrate/types.ts";
import { persistVerdict, verdictFilePath } from "../util/persistence.ts";
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
  /** Post-step failure detail (set only when `opts.post && !posted`). */
  postError?: PostError;
  /**
   * Absolute path to the on-disk verdict file (`.md` form, ready for
   * `gh pr review --body-file`). Always set when `persistVerdict`
   * succeeded — the operator can re-post manually after a post
   * failure. Built by workflow (which already owns the persist/post
   * sequence) so the bus layer doesn't need to know the storage
   * layout (sage#16 round-5 review).
   */
  recoveryPath?: string;
}

/**
 * Structured shape for a post-step failure. Plain JSON — no `Error`
 * prototype, no stack trace — so it can cross the NATS bus.
 */
export interface PostError {
  message: string;
}

/**
 * Cap on UTF-16 characters of `gh` stderr that ride the post-failed
 * envelope. 500 is enough to surface a typical `gh pr review` failure
 * (auth message, HTTP status + body snippet) without becoming a vector
 * for stderr-stuffing if the subprocess crashes mid-output. Internal —
 * tests assert observable truncation behavior, not this constant.
 */
const POST_ERROR_MAX_LEN = 500;

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

  // Lens execution is parallel: each lens runs against the same read-only
  // `pr`/`diff` inputs and produces a disjoint `LensReport`, so the
  // sequential awaits in the prior implementation were latency the
  // operator paid for, not correctness. Per cortex/docs/design-pi-dev-
  // review-agent.md §7 + sage#26.
  //
  // Each lens runs in its own async slot with an inline try/catch:
  //   - on success: the lens's own `LensReport` is returned
  //   - on throw:   an `errored: true` `LensReport` is synthesized
  //                 (severity `important`, captured elapsed time,
  //                 captured error message)
  //
  // Catching inline (rather than via `Promise.allSettled` post-processing)
  // ensures `onLensComplete` fires for BOTH the success and failure
  // paths. Per Holly re-review of sage#27 (finding #2): the lens-
  // failure event is the most important event in the progress stream,
  // and silently skipping the callback on rejection meant bridge
  // consumers never saw it. The lens-completion callback now has a
  // uniform contract: fires exactly once per applicable lens, with the
  // report (real or synthesized) the verdict will see.
  //
  // Order is preserved by filtering against the registry first;
  // `Promise.all` keeps the result array aligned with the input. The
  // rendered review body therefore reads the same way regardless of
  // which lens happened to finish first, which keeps verdict diffs
  // stable for downstream consumers (cortex dashboard, pilot loop) and
  // matches the registry-declared reading order in src/lenses/registry.ts
  // §canonical lens order.
  const applicable = LENSES.filter(
    (lens) => !lens.applies || lens.applies(ctx),
  );

  const lensReports: LensReport[] = await Promise.all(
    applicable.map(async (lens) => {
      const lensStartedAt = Date.now();
      let report: LensReport;
      try {
        report = await lens.review({
          pr,
          diff,
          substrate: opts.substrate,
          ...timeout,
        });
      } catch (err) {
        // Defense in depth — `runLens` (base.ts) catches substrate
        // errors and returns an `errored: true` report rather than
        // throwing, so today this branch is reached only by lens
        // implementations that bypass `runLens`. Behavior matches
        // base.ts's substrate-fallback path so both failure surfaces
        // produce the same verdict gate and the same rendered body.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[workflow] lens "${lens.name}" threw — synthesizing errored report: ${msg}`,
        );
        report = {
          lens: lens.name,
          summary: `Lens "${lens.name}" failed to execute; verdict cannot rely on this lens.`,
          findings: [
            {
              path: "(lens runtime)",
              line: 0,
              severity: "important" as const,
              title: `${lens.name}: lens runtime error`,
              rationale: msg,
            },
          ],
          durationMs: Date.now() - lensStartedAt,
          errored: true,
        };
      }
      // Progress callbacks (e.g., NATS publish in daemon mode) fire as
      // each lens completes, INCLUDING errored ones. Order is
      // completion-order, not registry-order — bridge consumers treat
      // `dispatch.task.progress` events as a stream. Callback failures
      // are non-critical: a publish error must not discard a completed
      // lens report.
      try {
        await opts.onLensComplete?.(report);
      } catch (cbErr) {
        const m = cbErr instanceof Error ? cbErr.message : String(cbErr);
        console.error(`[workflow] onLensComplete (${report.lens}) failed: ${m}`);
      }
      return report;
    }),
  );

  const verdict = decideVerdict(lensReports);
  const body = renderReviewBody(verdict, opts.substrate.displayName);

  // Persist the verdict + rendered body BEFORE the network call. If
  // `postReview` fails permanently, the operator can re-post from disk
  // without re-running the lenses. The file at
  // ~/.config/sage/reviews/<owner>-<repo>-<pr>.{json,md} holds the latest
  // verdict per PR; older ones are overwritten on next run.
  // The recovery path is built here (workflow already owns persist +
  // post) and threaded through `ReviewResult` only when persistence
  // actually succeeded. Bridge ships the opaque string in the
  // post-failed envelope payload; neither bus nor dispatcher needs a
  // compile-time dependency on the storage layout (sage#16 round-5).
  // Persist-failure → `recoveryPath` stays undefined so we don't
  // promise a file that isn't there (sage#16 round-6).
  const persisted = persistVerdict(opts.ref, verdict, body);
  const recoveryPath = persisted ? verdictFilePath(opts.ref, "md") : undefined;

  const { posted, postedEvent, downgraded, postError } = opts.post
    ? await attemptPost(opts.ref, verdict, body)
    : { posted: false };
  return {
    verdict,
    posted,
    ...(recoveryPath !== undefined ? { recoveryPath } : {}),
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
    // Errored lenses get a distinctive heading + callout so operators
    // see at a glance that a lens didn't actually run. The synthesized
    // `important` finding is still rendered below — the callout exists
    // because matching on path `(lens runtime)` / `(lens output)` was
    // the only signal in round-1 of sage#27, which Holly correctly
    // called inadequate. Round-2 fix: load-bearing visual marker.
    const heading = lens.errored
      ? `### ${lens.lens} — DID NOT RUN`
      : `### ${lens.lens}`;
    const callout = lens.errored
      ? "> ⚠ Lens failed to execute. Verdict cannot rely on this lens's coverage; re-run before merging.\n\n"
      : "";
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
    return `${heading}\n${callout}${lens.summary}\n\n${body}`;
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
