import { randomUUID } from "node:crypto";
import type { Subscription } from "nats";
import {
  safeDecodeEnvelope,
  type MyelinEnvelope,
} from "@the-metafactory/myelin";

import { connectNats } from "./connect.ts";
import { makeEmitter } from "./emit.ts";
import { buildSovereignty } from "../identity.ts";
import { parsePrRef } from "../github/gh.ts";
import type { DispatchTaskPayload as _DispatchTaskPayload } from "../tasks/types.ts";
import { describeEmission } from "../tasks/emissions.ts";
import {
  DEFAULT_STACK,
  deriveLifecycleWildcard,
  validateStack,
  verdictWildcard,
} from "../tasks/subjects.ts";

/**
 * @deprecated Import `DispatchTaskPayload` directly from `../tasks/types.ts`.
 * This re-export is a back-compat shim — the type's canonical home is the
 * protocol module, not this transport module. Remove in the next cleanup.
 *
 * Declared via local type alias (rather than `export type { … } from`)
 * so this `@deprecated` JSDoc binds directly to the exported identifier
 * — TS surfaces the strikethrough reliably at the consumer's import site
 * that way. Parallel to the value-side `ReviewTaskPayloadSchema` shim in
 * `bridge.ts`; both use a local rename for the same reason. The two
 * declarations look superficially different (value `const` vs `type`)
 * because JS and TS export a value and a type respectively — the intent
 * and the deprecation mechanism are identical.
 */
export type DispatchTaskPayload = _DispatchTaskPayload;

/**
 * Bus-domain dispatcher. Publishes a code-review task envelope to the
 * Myelin bus and waits for the verdict + lifecycle envelopes to come
 * back. Daemon-side counterpart lives in `bridge.ts` — both speak the
 * same protocol; this module is the publisher half, bridge.ts is the
 * subscriber half.
 *
 * Lives in src/bus/ alongside bridge.ts so all NATS-aware code shares a
 * single module boundary. CLI commands are thin shells that call into
 * this module.
 */

export interface DispatchOptions {
  prRef: string;
  natsUrl: string;
  org: string;
  source: string;
  credsFile?: string | undefined;
  /** CLI `--post`. See {@link buildReviewTaskPayload} for the omit-vs-false semantic. */
  post: boolean;
  /** Hard wait cap in seconds — exits non-zero if no completed/failed arrives. */
  waitSeconds: number;
  /**
   * Per-lens pi runner timeout (seconds) to forward to the daemon via
   * payload.timeout_ms. Daemon falls back to its own PI_TIMEOUT_MS / default
   * when this is absent.
   */
  timeoutSeconds?: number;
  /**
   * Data-residency code (ISO 3166 alpha-2) stamped on the task envelope.
   * Falls back to `MYELIN_DATA_RESIDENCY` / `SAGE_DATA_RESIDENCY` env /
   * `"CH"` when omitted.
   */
  dataResidency?: string;
  /**
   * Refuse to connect to NATS without usable creds. Sage PR#29 self-review
   * (CodeQuality, important): the daemon honored `SAGE_REQUIRE_NATS_AUTH`
   * via bridge.ts; the dispatcher silently fell back to unauthenticated.
   * Wiring it here closes the inconsistency.
   */
  requireNatsAuth?: boolean;
  /**
   * IoAW operator stack segment (sage#30, MY-101 Phase A). Single-stack
   * operators pass `"default"`; multi-stack operators set `SAGE_STACK`.
   * Defaults to `"default"` when omitted.
   */
  stack?: string;
}

export interface BuildReviewTaskPayloadInput {
  prUrl: string;
  /** Boolean from CLI; only `true` → opt-in. `false` → omit field. */
  post: boolean;
  /** Optional per-lens pi timeout to forward to the daemon (seconds). */
  timeoutSeconds?: number;
}

/**
 * Pure helper that shapes the dispatch envelope's payload. Extracted so the
 * fix for sage#8 is unit-testable without bringing up NATS. The function is
 * a single-callsite helper today (only `dispatchReview` calls it in
 * production); the explicit tradeoff is broader-public-surface for
 * round-trip-free unit coverage of the subtle `??`-omit semantic.
 *
 * Semantic: `post` is OPT-IN only. The CLI's `--post` flag (default false)
 * sends `payload.post=true` when set, and OMITS the field otherwise.
 * Omitting lets the bridge's `payload.post ?? cfg.postReviews` lookup fall
 * through to the daemon-side default; sending an explicit `false` would
 * short-circuit past that default (??-coalesce treats false as a value).
 */
export function buildReviewTaskPayload(input: BuildReviewTaskPayloadInput): _DispatchTaskPayload {
  return {
    pr_url: input.prUrl,
    ...(input.post ? { post: true as const } : {}),
    ...(input.timeoutSeconds ? { timeout_ms: input.timeoutSeconds * 1000 } : {}),
  };
}

export async function dispatchReview(opts: DispatchOptions): Promise<number> {
  const ref = parsePrRef(opts.prRef);

  const nc = await connectNats({
    natsUrl: opts.natsUrl,
    ...(opts.credsFile ? { credsFile: opts.credsFile } : {}),
    log: (m) => log(m),
    ...(opts.requireNatsAuth ? { requireAuth: true } : {}),
  });
  log(`connected ${opts.natsUrl}`);

  const correlationId = randomUUID();
  const sovereignty = buildSovereignty(
    opts.dataResidency ? { data_residency: opts.dataResidency } : undefined,
  );
  const baseEmit = makeEmitter({
    nc,
    source: opts.source,
    sovereignty,
    log: (m) => log(m),
  });
  const capability = "code-review.typescript";
  const taskPayload = buildReviewTaskPayload({
    prUrl: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    post: opts.post,
    ...(opts.timeoutSeconds ? { timeoutSeconds: opts.timeoutSeconds } : {}),
  });

  // Subscribe to lifecycle + verdict subjects BEFORE publishing so we cannot
  // miss a fast-completing daemon's reply. Filter by correlation_id so
  // concurrent reviews don't cross-talk.
  const stack = validateStack(opts.stack ?? DEFAULT_STACK);
  const lifecycleSub = nc.subscribe(deriveLifecycleWildcard(opts.org, stack));
  const verdictSub = nc.subscribe(verdictWildcard(opts.org, stack, "review"));

  let terminated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const done = new Promise<number>((resolve) => {
    const finish = (code: number) => {
      if (terminated) return;
      terminated = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    };

    void consume(lifecycleSub, correlationId, (env, subject) => {
      log(`◀ ${subject} ${env.type}`);
      const payload = env.payload ?? {};

      // `dispatch.task.post-failed` (sage#16) is the operational sibling
      // of `dispatch.task.failed` — lens work succeeded, GH post
      // crashed. The verdict is on disk at
      // ~/.config/sage/reviews/<safe>-<safe>-<n>.{json,md}; surface a
      // recovery hint with operator-typeable values. CRITICAL: the ref
      // owner/repo come from a NATS publisher that this process does
      // NOT control, so they pass through `sanitizeRefSegment` before
      // any string interpolation — same character class
      // `persistVerdict` uses for its on-disk filename, which also
      // means the printed `cat` path matches what's actually on disk.
      if (env.type === "dispatch.task.post-failed") {
        handlePostFailed(payload);
        // dispatch.task.completed still arrives after this — let it
        // resolve the dispatcher exit code.
        return;
      }

      if (Object.keys(payload).length > 0) {
        log(`  payload: ${JSON.stringify(payload)}`);
      }
      if (env.type === "dispatch.task.completed") {
        finish(0);
      } else if (env.type === "dispatch.task.failed") {
        finish(1);
      }
    });

    void consume(verdictSub, correlationId, (env, subject) => {
      log(`◀ ${subject} ${env.type}`);
      const payload = env.payload;
      const decision =
        typeof payload.verdict === "object" && payload.verdict !== null
          ? (payload.verdict as Record<string, unknown>).decision
          : env.type.replace("code.pr.review.", "");
      log(`  verdict: ${decision} (posted=${payload.posted ?? false})`);
      // Verdict alone doesn't terminate the dispatcher — wait for
      // dispatch.task.completed which arrives right after.
    });

    timer = setTimeout(() => {
      log(`timed out after ${opts.waitSeconds}s — no completed/failed envelope received`);
      finish(2);
    }, opts.waitSeconds * 1000);
  });

  log(`▶ publishing tasks.${capability} (correlation=${correlationId})`);
  const { subject: taskSubj, type: taskType } = describeEmission(
    opts.org,
    stack,
    {
      kind: "task",
      capability,
      payload: taskPayload as Record<string, unknown>,
    },
  );

  // Sage PR#29 R2 [important]: cleanup must run even if `baseEmit` throws
  // during validate or `nc.publish`. Without the try/finally, a publish
  // failure would leave the wait timer + two subscriptions hanging until
  // process exit.
  try {
    await baseEmit({
      subject: taskSubj,
      type: taskType,
      payload: taskPayload as Record<string, unknown>,
      correlationId,
    });
    return await done;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await nc.drain();
    } catch (drainErr) {
      const m = drainErr instanceof Error ? drainErr.message : String(drainErr);
      log(`drain failed during cleanup: ${m}`);
    }
  }
}

async function consume(
  sub: Subscription,
  correlationId: string,
  onMatch: (envelope: MyelinEnvelope, subject: string) => void,
): Promise<void> {
  for await (const msg of sub) {
    const envelope = safeDecodeEnvelope(msg.data, msg.subject, {
      onError: (reason, subject) => log(`${reason} on ${subject ?? "?"}`),
    });
    if (!envelope) continue;
    if (envelope.correlation_id !== correlationId) continue;
    onMatch(envelope, msg.subject);
  }
}

const LOG_PREFIX = "[sage:dispatch]";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX} ${msg}`);
}

/**
 * Format the `dispatch.task.post-failed` envelope payload into operator-
 * facing log lines: the error summary plus the recovery hint.
 *
 * Uses ONLY `payload.recovery_path` for the hint — `ref.owner` and
 * `ref.repo` are NOT interpolated to avoid any possibility of shell
 * metacharacters in attacker-influenced fields reaching the operator's
 * terminal via `console.error`. The operator copies the printed `cat`
 * command and pipes it to their own `gh pr review` invocation with
 * the repo coords they already know.
 */
/**
 * Whitelist for the recovery_path string — absolute path, slug-safe
 * segments, ends with `.md`. CRITICALLY: rejects any segment that is
 * `..` (path-traversal vector). Anything else means the envelope was
 * malformed or hostile; we drop the recovery hint rather than echo
 * arbitrary text into the operator's terminal.
 */
function isSafeRecoveryPath(p: string): boolean {
  if (!p.startsWith("/") || !p.endsWith(".md")) return false;
  if (!/^[A-Za-z0-9_./-]+$/.test(p)) return false;
  // Reject any `..` segment — `/foo/../bar.md` could traverse out of
  // the reviews directory. The slug regex above lets `..` through as
  // chars; this explicit segment check closes that gap.
  return !p.split("/").includes("..");
}

function handlePostFailed(payload: Record<string, unknown>): void {
  const errObj = payload.error as { message?: unknown } | string | undefined;
  const errorMsg =
    typeof errObj === "string"
      ? errObj
      : typeof errObj?.message === "string"
        ? errObj.message
        : "<no error message>";
  log(`  post-failed: ${errorMsg}`);

  const recoveryPath = payload.recovery_path;
  if (typeof recoveryPath === "string" && isSafeRecoveryPath(recoveryPath)) {
    log(`  recover: cat ${recoveryPath} | gh pr review --body-file -  # add --repo OWNER/REPO and PR number`);
  }
}

