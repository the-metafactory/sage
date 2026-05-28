import type {
  ForgeBackend,
  PrRef,
  ReviewEvent,
} from "../forge/types.ts";
import { createPriorFindings } from "../prior-findings/index.ts";
import type {
  PriorFindings,
  PriorFindingsStatus,
} from "../prior-findings/index.ts";
import type { Substrate } from "../substrate/types.ts";
import { loadArchitectureDocs } from "./architecture-docs.ts";
import { architectureApplies } from "./applicability.ts";
import {
  decideVerdict,
  persistVerdict,
  renderVerdict,
  type Verdict,
  verdictFilePath,
  verdictToEvent,
} from "../verdict/index.ts";
import { LENSES } from "./registry.ts";
import {
  readConcurrencyEnv,
  runLenses,
} from "./scheduler.ts";
import type { LensReport } from "./types.ts";

export interface ReviewOptions {
  ref: PrRef;
  /**
   * Forge backend (GitHub, GitLab, etc.) that performs all
   * platform-specific I/O for this review. Resolved once per CLI
   * invocation or bus task by `selectForge` — the workflow itself
   * stays forge-agnostic so adding a third forge is a single new
   * backend file, not a workflow rewrite (sage#43 Phase 5).
   */
  forge: ForgeBackend;
  /**
   * Substrate that backs every lens for this review. Resolved once per
   * process at startup by the CLI / daemon (`selectSubstrate`) — Sage
   * deliberately does NOT support per-task substrate selection so verdicts
   * stay reproducible across operators. See issue #14 "Out of scope".
   */
  substrate: Substrate;
  /** Post the review back to the forge. Default: false (dry-run). */
  post?: boolean;
  /** Per-lens substrate timeout. Falls back to substrate-specific default. */
  timeoutMs?: number;
  /**
   * Max concurrent lens executions. Undefined preserves the historical
   * fully-parallel behavior; set via CLI flag or SAGE_LENS_CONCURRENCY.
   */
  lensConcurrency?: number;
  /**
   * Prior Findings Module — fetches Sage-authored findings from earlier
   * Reviews on the same PR (CONTEXT.md). When omitted, defaults from
   * `opts.forge.reviewSource()`.
   */
  priorFindings?: PriorFindings;
  /**
   * Fired when `priorFindings.collect()` returns a non-`ok` status.
   * Used by `sage dispatch` to surface the degradation on a Lifecycle
   * envelope payload (sage#56).
   */
  onPriorFindingsDegraded?: (status: PriorFindingsStatus, reason: string) => void | Promise<void>;
  /** Progress callback fired after each lens completes — envelope emission. */
  onLensComplete?: (report: LensReport) => void | Promise<void>;
}

export interface ReviewResult {
  verdict: Verdict;
  /**
   * True only when `opts.post` was set AND `postReview` actually returned
   * without throwing (sage#16).
   */
  posted: boolean;
  postedEvent?: ReviewEvent;
  downgraded?: boolean;
  /** Post-step failure detail (set only when `opts.post && !posted`). */
  postError?: PostError;
  /**
   * Absolute path to the on-disk verdict file (`.md` form, ready for
   * `gh pr review --body-file`). Set when `persistVerdict` succeeded.
   */
  recoveryPath?: string;
}

export interface PostError {
  message: string;
}

const POST_ERROR_MAX_LEN = 500;

/** Re-export for back-compat with existing CLI callers (sage#59). */
export { parseConcurrencyValue, readConcurrencyEnv } from "./scheduler.ts";

/**
 * Strip control bytes + ANSI escapes — gh stderr can include color
 * codes / attacker-shaped content reflected from a remote repo name.
 * Sanitized before the message rides the NATS bus or hits the
 * operator's terminal.
 */
function sanitizeErrorMessage(raw: string): string {
  // ORDER MATTERS: CSI pattern must come BEFORE the control-byte
  // class so `\x1b[31m` matches as a unit, not as `\x1b` + `[31m`.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-9;]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export async function reviewPr(opts: ReviewOptions): Promise<ReviewResult> {
  const priorFindingsModule: PriorFindings =
    opts.priorFindings ?? createPriorFindings(opts.forge.reviewSource());

  const [pr, diff, priorResult] = await Promise.all([
    opts.forge.prView(opts.ref),
    opts.forge.prDiff(opts.ref),
    priorFindingsModule.collect(opts.ref),
  ]);
  const architectureDocs = architectureApplies({ pr, diff })
    ? await loadArchitectureDocs({
        forge: opts.forge,
        ref: opts.ref,
        baseRefName: pr.baseRefName,
      })
    : undefined;

  if (priorResult.status !== "ok") {
    const reason = priorResult.reason ?? "";
    console.error(
      `[workflow] prior Sage findings degraded (${priorResult.status}); continuing without iteration context: ${reason}`,
    );
    try {
      await opts.onPriorFindingsDegraded?.(priorResult.status, reason);
    } catch (cbErr) {
      const m = cbErr instanceof Error ? cbErr.message : String(cbErr);
      console.error(`[workflow] onPriorFindingsDegraded failed: ${m}`);
    }
  }

  const concurrency =
    opts.lensConcurrency ?? readConcurrencyEnv("SAGE_LENS_CONCURRENCY");

  const lensReports = await runLenses({
    lenses: LENSES,
    ctx: { pr, diff },
    substrate: opts.substrate,
    priorFindings: priorResult.findings,
    ...(architectureDocs !== undefined ? { architectureDocs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(opts.onLensComplete !== undefined ? { onLensComplete: opts.onLensComplete } : {}),
  });

  const verdict = decideVerdict(lensReports);
  const body = renderVerdict(verdict, opts.substrate.displayName);

  // Persist BEFORE post: a failed post leaves the verdict on disk
  // for manual re-post via `gh pr review --body-file` (sage#16).
  const persisted = persistVerdict(opts.ref, verdict, body);
  const recoveryPath = persisted ? verdictFilePath(opts.ref, "md") : undefined;

  const { posted, postedEvent, downgraded, postError } = opts.post
    ? await attemptPost(opts.forge, opts.ref, verdict, body)
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
 * Attempt the Forge post step. Pure helper extracted from `reviewPr`
 * so the data flow is explicit (return value, not outer-scope
 * mutations) and `reviewPr` stays scannable. Never re-throws —
 * pre-sage#16, a `postReview` throw escaped and conflated a post
 * failure with a lens failure.
 */
async function attemptPost(
  forge: ForgeBackend,
  ref: PrRef,
  verdict: Verdict,
  body: string,
): Promise<AttemptPostResult> {
  const target = `${ref.owner}/${ref.repo}#${ref.number}`;
  // eslint-disable-next-line no-console
  console.error(`[workflow] post: attempting ${target} (decision=${verdict.decision})`);

  try {
    const result = await forge.postReview({
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
    // partially-survive past the slice boundary.
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
