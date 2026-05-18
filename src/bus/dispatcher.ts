import { randomUUID } from "node:crypto";
import type { Subscription } from "nats";
import {
  safeDecodeEnvelope,
  type MyelinEnvelope,
} from "@the-metafactory/myelin";

import { connectNats } from "./connect.ts";
import { makeEmitter } from "./emit.ts";
import { buildSovereignty } from "../identity.ts";
import { parsePrRef } from "../forge/parse.ts";
import type { DispatchTaskPayload as _DispatchTaskPayload } from "../tasks/types.ts";
import { describeEmission } from "../tasks/emissions.ts";
import {
  deriveLifecycleWildcard,
  verdictWildcard,
} from "@the-metafactory/myelin";
import { resolveStack } from "../util/stack.ts";

/**
 * @deprecated Import `DispatchTaskPayload` directly from `../tasks/types.ts`.
 * This re-export is a back-compat shim — the type's canonical home is the
 * protocol module, not this transport module. Remove in the next cleanup.
 *
 * Declared via local type alias (rather than `export type { … } from`)
 * so this `@deprecated` JSDoc binds directly to the exported identifier
 * — TS surfaces the strikethrough reliably at the consumer's import site
 * that way.
 */
export type DispatchTaskPayload = _DispatchTaskPayload;

/**
 * Bus-domain dispatcher. Publishes a code-review task envelope to the
 * Myelin bus and waits for the verdict + lifecycle envelopes to come
 * back.
 *
 * sage#40 — the receiver side previously lived in `src/bus/bridge.ts` as
 * a standalone launchd-supervised daemon. That daemon retired when sage
 * moved in-process inside cortex; cortex's `ReviewConsumer` (cortex#237)
 * now owns the subscribe loop and invokes sage's review pipeline
 * (`src/lenses/workflow.ts` → `reviewPr`) as an injected
 * `pipelineRunner`. This module is now the only NATS-aware code in sage
 * and exists for the operator-facing `sage dispatch` CLI command, plus
 * any other publisher half a consumer might want to drive directly.
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
   * (CodeQuality, important): the daemon-side equivalent on the legacy
   * bridge.ts honored `SAGE_REQUIRE_NATS_AUTH`; the dispatcher silently
   * fell back to unauthenticated. Wiring it here closes the inconsistency
   * (and the daemon has since retired — see sage#40).
   */
  requireNatsAuth?: boolean;
  /**
   * IoAW operator stack segment (sage#30, MY-101 Phase A). Single-stack
   * operators pass `"default"`; multi-stack operators set `SAGE_STACK`.
   * Defaults to `"default"` when omitted.
   */
  stack?: string;
  /**
   * Informational reviewer name per cortex#237 §4.1. Sage dispatch
   * defaults to `"capability-dispatch"` to make the routing semantic
   * visible — cortex routes by capability, NOT by this field
   * (sage#52). Operators override when the dashboard / renderer
   * surface should display a specific reviewer name.
   */
  reviewer?: string;
}

export interface BuildReviewTaskPayloadInput {
  /**
   * Parsed PR/MR reference. Drives `payload.repo` (slash-joined
   * "owner/repo"), `payload.pr` (the integer number), and the legacy
   * `payload.pr_url` field via `buildRefUrl(ref)`. Cortex#237's
   * `parseReviewRequestPayload` reads `repo` + `pr`; `pr_url` is kept
   * for back-compat with any pre-cortex#237 receivers (sage#52).
   */
  ref: import("../forge/types.ts").PrRef;
  /** Boolean from CLI; only `true` → opt-in. `false` → omit field. */
  post: boolean;
  /** Optional per-lens pi timeout to forward to the daemon (seconds). */
  timeoutSeconds?: number;
  /**
   * Forge kind. Omitted on the wire when value is `"github"` so legacy
   * receivers see byte-stable payload shape; non-github value (today
   * `"gitlab"`) is included as an additive optional field
   * (sage#43 Q3 — additive, no schema break).
   */
  forge?: "github" | "gitlab";
  /**
   * Informational reviewer name per cortex#237 §4.1
   * `ReviewRequestPayload.reviewer`. Cortex routes by capability
   * (the `<flavor>` subject suffix), NOT by this field — it surfaces
   * in the dashboard / renderer as "review requested from {reviewer}".
   * Default `"capability-dispatch"` documents that intent verbatim;
   * operators can override via the dispatcher's `reviewer` opt.
   */
  reviewer?: string;
}

/**
 * Build the operator-facing PR/MR URL for a `PrRef`. Used by the
 * dispatcher to fill `payload.pr_url`. GitLab branch picks the host
 * from `ref.host` when set, falling back to the GitLab default —
 * consistent with how the GitLab backend resolves a host on
 * outbound API calls.
 */
export function buildRefUrl(ref: import("../forge/types.ts").PrRef): string {
  const kind = ref.kind ?? "github";
  if (kind === "gitlab") {
    const host = ref.host ?? "gitlab.com";
    return `https://${host}/${ref.owner}/${ref.repo}/-/merge_requests/${ref.number}`;
  }
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
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
    // cortex#237 §4.1 contract fields — what cortex's
    // `parseReviewRequestPayload` actually validates against. Pre-#52
    // sage dispatch only sent `pr_url`, so every task hit
    // `cant_do: payload validation failed (missing/invalid repo or pr)`.
    repo: `${input.ref.owner}/${input.ref.repo}`,
    pr: input.ref.number,
    reviewer: input.reviewer ?? "capability-dispatch",
    // Back-compat: legacy receivers that still read `pr_url` (sage's
    // own bridge pre-cortex#237) keep working. Cortex's pipeline reads
    // `repo`/`pr` and ignores `pr_url`.
    pr_url: buildRefUrl(input.ref),
    ...(input.post ? { post: true as const } : {}),
    ...(input.timeoutSeconds ? { timeout_ms: input.timeoutSeconds * 1000 } : {}),
    ...(input.forge && input.forge !== "github" ? { forge: input.forge } : {}),
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
  const forgeKind: "github" | "gitlab" = ref.kind ?? "github";
  const taskPayload = buildReviewTaskPayload({
    ref,
    post: opts.post,
    ...(opts.timeoutSeconds ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    // Additive `forge` field on the payload — preserves byte-stable
    // shape for existing receivers that omit the field (sage#43 Q3,
    // additive optional field). Omitted entirely when forge is github,
    // so legacy consumers see the payload they always saw.
    forge: forgeKind,
    // `reviewer` defaults to "capability-dispatch" inside the helper
    // (sage#52 / cortex#237). Operator can override here via opts.reviewer
    // once the CLI flag for it lands; today the default value documents
    // that cortex routes by capability, not reviewer name.
    ...(opts.reviewer !== undefined ? { reviewer: opts.reviewer } : {}),
  });

  // Subscribe to lifecycle + verdict subjects BEFORE publishing so we cannot
  // miss a fast-completing daemon's reply. Filter by correlation_id so
  // concurrent reviews don't cross-talk.
  const stack = resolveStack(opts.stack);
  const lifecycleSub = nc.subscribe(deriveLifecycleWildcard(opts.org, stack));
  const verdictSub = nc.subscribe(verdictWildcard(opts.org, "review", stack));

  let terminated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  // sage#49 — `dispatch.task.received` is the first lifecycle envelope
  // cortex's consumer emits after claiming a task. If no `received`
  // arrives within `SILENCE_WARN_MS`, the dispatch is almost certainly
  // hitting a subject the consumer side isn't subscribed to (org-segment
  // mismatch with cortex.yaml `operator.id`, stack-segment mismatch, or
  // a fully-dormant runtime per cortex#335 / G-1111). Surface an
  // actionable warning to stderr without terminating — the primary wait
  // continues, the operator just gets a hint to check.
  let receivedSeen = false;

  const done = new Promise<number>((resolve) => {
    const finish = (code: number) => {
      if (terminated) return;
      terminated = true;
      if (timer) clearTimeout(timer);
      if (silenceTimer) clearTimeout(silenceTimer);
      resolve(code);
    };

    void consume(lifecycleSub, correlationId, (env, subject) => {
      log(`◀ ${subject} ${env.type}`);
      const payload = env.payload ?? {};

      // Any lifecycle envelope for this correlation_id is sufficient
      // signal that SOME consumer claimed the task — `received` is the
      // first one but `started` / `completed` / `failed` count too.
      // Cancel the silence timer; the warning would mislead if it fired
      // after the fact.
      receivedSeen = true;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = undefined;
      }

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

    // sage#49 — silence-warning timer. Fires once at SILENCE_WARN_MS
    // if no lifecycle envelope has arrived for this correlation_id,
    // pointing the operator at the three most likely root causes:
    // org / stack mismatch and the cortex#335 / G-1111 dormant
    // runtime gap. Does NOT terminate — `finish` is reserved for the
    // primary wait timer or a real lifecycle terminal envelope.
    silenceTimer = setTimeout(() => {
      if (!shouldEmitSilenceWarning({ terminated, receivedSeen })) return;
      log(buildSilenceWarning({ org: opts.org, stack }));
    }, SILENCE_WARN_MS);
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

/**
 * sage#49 — silence threshold before the dispatcher emits a stderr
 * warning suggesting org/stack/dormant-runtime diagnosis. 5s is the
 * smallest interval that comfortably absorbs normal lifecycle
 * round-trip latency on a healthy local NATS while still firing
 * quickly enough to help an operator catch a mistyped `--org` before
 * they walk away assuming the dispatch is just slow.
 *
 * Exported so tests can pin the contract without standing up a NATS
 * broker.
 */
export const SILENCE_WARN_MS = 5_000;

/**
 * Pure-function policy for the silence-warning timer (sage#49). Returns
 * true iff the warning should be emitted — false when the dispatcher
 * already terminated OR a lifecycle envelope arrived between the timer
 * being scheduled and firing. Extracted so the policy is unit-testable
 * without timer mocks.
 */
export function shouldEmitSilenceWarning(state: {
  terminated: boolean;
  receivedSeen: boolean;
}): boolean {
  return !state.terminated && !state.receivedSeen;
}

/**
 * Build the operator-facing silence-warning string (sage#49). Centralised
 * so the wording stays consistent between the dispatcher and its tests;
 * also makes it cheap to grep for the warning shape from a log shipper.
 */
export function buildSilenceWarning(opts: {
  org: string;
  stack: string;
  silenceMs?: number;
}): string {
  const seconds = (opts.silenceMs ?? SILENCE_WARN_MS) / 1000;
  return (
    `⚠ no consumer claim after ${seconds}s — verify cortex.yaml operator.id ` +
    `matches --org "${opts.org}" and stack matches "${opts.stack}" ` +
    `(see sage#49). If both align, cortex's review consumer may be DORMANT ` +
    `(see cortex#335 / G-1111).`
  );
}

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

