import { type NatsConnection, type Subscription } from "nats";
import {
  safeDecodeEnvelope,
  type MyelinEnvelope,
} from "@the-metafactory/myelin";

import { connectNats } from "./connect.ts";
import { makeEmitter, type Emitter } from "./emit.ts";
import { buildSovereignty } from "../identity.ts";
import { parsePrRef, type PrRef } from "../github/gh.ts";
import { reviewPr } from "../lenses/workflow.ts";
import type { Substrate } from "../substrate/types.ts";
import { TaskPayloadSchema, type ReviewTaskPayload } from "../tasks/types.ts";
import { describeEmission, type Emission } from "../tasks/emissions.ts";
import {
  broadcastTaskSubject,
  directTaskSubject,
  DEFAULT_STACK,
  validateStack,
} from "../tasks/subjects.ts";

/**
 * @deprecated Import `TaskPayloadSchema` directly from `../tasks/types.ts`
 * and remove this re-export in the next cleanup pass. Two living names for
 * the same export is the kind of low-grade drift sage#10 was meant to
 * eliminate. Module location moved from `./payload.ts` to
 * `../tasks/types.ts` in the myelin v0.2 adoption (PR#29) for cedar-
 * structural parity.
 *
 * Declared as `const` (rather than `export { … as … } from`) so this
 * `@deprecated` tag binds directly to the alias identifier — TS surfaces
 * the strikethrough reliably at the consumer's import site that way,
 * which the bare re-export form does not always do across editors.
 */
export const ReviewTaskPayloadSchema = TaskPayloadSchema;
export type { ReviewTaskPayload } from "../tasks/types.ts";

export interface BridgeConfig {
  natsUrl: string;
  org: string;
  source: string;
  did: string;
  /**
   * Substrate that backs every review handled by this daemon. Resolved
   * once at CLI startup via `selectSubstrate` — selection is daemon-level
   * by design (issue #14 "Out of scope": per-task substrate is deliberately
   * not supported, to keep verdicts reproducible across operators).
   */
  substrate: Substrate;
  capabilities?: readonly string[];
  /** Default to true; set false to log-only for dry-run testing. */
  postReviews?: boolean;
  /**
   * Max concurrent reviews. Each review spawns a substrate subprocess and
   * competes for LLM API rate limit + memory; unbounded is dangerous under
   * load. Defaults to 3. Phase 2 should replace this in-process gate with a
   * NATS JetStream consumer group `max_ack_pending`.
   */
  maxConcurrentTasks?: number;
  /**
   * Max concurrent lens executions within each review. Undefined preserves
   * fully-parallel lens execution.
   */
  lensConcurrency?: number;
  /**
   * Path to a NATS user `.creds` file (nsc-generated). When set, the bridge
   * authenticates with the broker. Falls back to `NATS_CREDS_FILE` env var.
   * Unauthenticated when neither is set (dev / local broker only).
   */
  credsFile?: string;
  /**
   * NATS queue-group **base** name for the broadcast + direct subscriptions.
   * Multiple Sage instances joining the same group share work via
   * competing-consumer semantics (only one delivery per message). Defaults
   * to `sage-review`.
   *
   * **sage#35**: the bridge appends `-<stack>` to this base name before
   * subscribing, so two sage instances on different operator stacks
   * (`andreas/research` vs `andreas/production`) get distinct queue groups
   * and don't steal each other's work. Operators rarely need to override
   * this; the only legitimate use is running multiple sage instances on
   * the SAME stack that should NOT compete (e.g. one for `code-review`,
   * one for `code-review-priority`).
   */
  queueGroup?: string;
  /** Refuse to connect without usable NATS creds (recommended in production). */
  requireNatsAuth?: boolean;
  /**
   * Data-residency code (ISO 3166 alpha-2) stamped on every outbound
   * envelope's sovereignty block. When omitted, `buildSovereignty` falls
   * back to `MYELIN_DATA_RESIDENCY` / `SAGE_DATA_RESIDENCY` env / `"CH"`.
   */
  dataResidency?: string;
  /**
   * IoAW operator stack segment (sage#30, MY-101 Phase A). Single-stack
   * operators pass `"default"`; multi-stack operators set `SAGE_STACK`.
   * Defaults to `"default"` when omitted.
   */
  stack?: string;
}

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error(`Semaphore max must be >= 1 (got ${max})`);
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    if (this.active <= 0) {
      // Log-and-noop instead of throwing. release() is called inside
      // `.finally(() => sem.release())` on a void-ed promise chain; a
      // throw there becomes an unhandled rejection and crashes the
      // event loop. The invariant violation is still surfaced via the
      // stack trace, just not by killing the daemon.
      // eslint-disable-next-line no-console
      console.error(
        new Error("Semaphore released more times than acquired").stack ??
          "Semaphore underflow",
      );
      return;
    }
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  get inFlight(): number {
    return this.active;
  }
}

export interface RunningBridge {
  close(): Promise<void>;
  connection: NatsConnection;
}

export async function startBridge(cfg: BridgeConfig): Promise<RunningBridge> {
  // Connect via the shared helper. It handles creds-path resolution, the
  // ENOENT soft-fallback (missing sage.creds file is a legitimate dev
  // state), authenticator setup, and optional refuse-without-auth
  // enforcement. Both bridge.ts and dispatcher.ts use the same helper
  // so transport behavior can't drift between them.
  const nc = await connectNats({
    natsUrl: cfg.natsUrl,
    ...(cfg.credsFile ? { credsFile: cfg.credsFile } : {}),
    log: (m) => log(`bridge: ${m}`),
    ...(cfg.requireNatsAuth ? { requireAuth: true } : {}),
  });
  // Register connection-level event listeners BEFORE any subscribe/publish.
  // The nats.js client emits 'error' on the connection (not via thrown
  // exceptions) for transport-level failures during fire-and-forget
  // publish, plus normal status events for reconnect cycles. Without an
  // 'error' listener Node.js's EventEmitter would throw and crash the
  // daemon.
  void watchConnectionStatus(nc);

  const stack = validateStack(cfg.stack ?? DEFAULT_STACK);
  // sage#35 — include `stack` in the queue group name so two sage
  // instances on different stacks (e.g. `andreas/research` and
  // `andreas/production`) subscribing the same capability don't steal
  // each other's work via NATS round-robin queue-group semantics.
  // Single-stack operators see the same name as before via the
  // `default` stack — `sage-review-default` — which is still a stable
  // identifier for one logical work-stream. Plan §600 lean (queue-group
  // naming should include the stack so cross-stack contention can't
  // happen).
  const queue = `${cfg.queueGroup ?? "sage-review"}-${stack}`;

  // Stack-aware (6-segment) subscriptions, the canonical IoAW Phase A.5
  // shape `local.{org}.{stack}.tasks.{capability}.>`. Ecosystem publishers
  // (cortex#262 `MyelinRuntime.publish`, pilot#110 publish-review-request,
  // myelin#152 helper migration) cut over to 6-segment at the same time;
  // no dual-subscription migration adapter needed at the bridge layer.
  // The cross-version backward-compat bridge for any legacy 5-segment
  // emitter is tracked by myelin#156 (namespace.md:88 normalisation rule).
  const broadcastSubj = broadcastTaskSubject(cfg.org, stack, "code-review");
  const directSubj = directTaskSubject(cfg.org, stack, cfg.did);

  const broadcast = nc.subscribe(broadcastSubj, { queue });
  const direct = nc.subscribe(directSubj, { queue });

  const concurrencyLimit = cfg.maxConcurrentTasks ?? 3;
  const sem = new Semaphore(concurrencyLimit);

  log(`bridge: connected ${cfg.natsUrl}`);
  log(`bridge: subscribed ${broadcastSubj} (queue=${queue})`);
  log(`bridge: subscribed ${directSubj} (queue=${queue})`);
  log(`bridge: maxConcurrentTasks=${concurrencyLimit}`);

  const onLoopFailure = (which: string) => async (err: unknown) => {
    const m = err instanceof Error ? err.message : String(err);
    log(`bridge: FATAL — ${which} consumer loop died: ${m}`);
    log(`bridge: draining surviving connections before exit (max ~10s)`);
    // Drain lets the other consumer loop finish its in-flight task so its
    // semaphore slot can release cleanly — abandoned work is the cost of
    // a hard process.exit. Bounded by NATS's internal drain timeout.
    try {
      await nc.drain();
    } catch (drainErr) {
      const dm = drainErr instanceof Error ? drainErr.message : String(drainErr);
      log(`bridge: drain on FATAL failed: ${dm}`);
    }
    // launchd / systemd restart the daemon on this non-zero exit.
    process.exit(1);
  };
  void consumeSubscription(broadcast, "broadcast", cfg, nc, sem).catch(onLoopFailure("broadcast"));
  void consumeSubscription(direct, "direct", cfg, nc, sem).catch(onLoopFailure("direct"));

  return {
    connection: nc,
    async close() {
      await nc.drain();
    },
  };
}

async function consumeSubscription(
  sub: Subscription,
  mode: "broadcast" | "direct",
  cfg: BridgeConfig,
  nc: NatsConnection,
  sem: Semaphore,
): Promise<void> {
  for await (const msg of sub) {
    const envelope = safeDecodeEnvelope(msg.data, msg.subject, {
      onError: (reason, subject) => log(`bridge: ${reason} on ${subject ?? "?"}`),
    });
    if (!envelope) continue;

    // Block the consumer loop until a concurrency slot is available. Back-
    // pressure here propagates to NATS via slow consumer detection rather
    // than spawning unbounded pi subprocesses. Phase 2: switch to a
    // JetStream pull consumer with explicit ack + max_ack_pending.
    await sem.acquire();
    log(`bridge: ${mode} task ${envelope.id} (type=${envelope.type}, in-flight=${sem.inFlight})`);
    void handleTask(envelope, cfg, nc)
      .catch((err) => {
        log(`bridge: handler crashed for ${envelope.id}: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => sem.release());
  }
}

async function handleTask(
  env: MyelinEnvelope,
  cfg: BridgeConfig,
  nc: NatsConnection,
): Promise<void> {
  const corrId = env.correlation_id ?? env.id;
  // `cfg.stack` was validated at startBridge time via `validateStack` —
  // the daemon would not have reached this point if it were malformed.
  // Capture once to keep the emit closure free of the `?? DEFAULT_STACK`
  // fall-through that startBridge already resolved (Holly review on
  // PR#31, nit #1).
  const stack = cfg.stack ?? DEFAULT_STACK;
  const sovereignty = buildSovereignty(
    cfg.dataResidency ? { data_residency: cfg.dataResidency } : undefined,
  );
  const substrateExtensions = { substrate: cfg.substrate.name };

  // Generic transport emitter (bus boundary) — domain descriptors come
  // from `src/tasks/emissions.ts`. `publish(emission, extensions?)`
  // resolves subject + type via `describeEmission`, then hands the result
  // to the transport.
  const baseEmit: Emitter = makeEmitter({
    nc,
    source: cfg.source,
    sovereignty,
    log: (m) => log(`bridge: ${m}`),
  });
  const emit = (
    emission: Emission,
    extensions?: Record<string, unknown>,
  ): Promise<void> => {
    const { subject, type } = describeEmission(cfg.org, stack, emission);
    return baseEmit({
      subject,
      type,
      payload: emission.payload,
      correlationId: corrId,
      ...(extensions ? { extensions } : {}),
    });
  };

  const payloadResult = TaskPayloadSchema.safeParse(env.payload);
  if (!payloadResult.success) {
    await emit({
      kind: "lifecycle",
      state: "failed",
      payload: { reason: "invalid-payload", detail: payloadResult.error.message },
    });
    return;
  }
  const payload = payloadResult.data;
  const ref = resolvePrRef(payload);
  if (!ref) {
    // Defensive — Zod's `.refine()` does not narrow the output type, so the
    // compiler cannot prove non-null on `owner/repo/number`. The schema
    // refinement above already guarantees at least one branch is present.
    await emit({
      kind: "lifecycle",
      state: "failed",
      payload: {
        reason: "invalid-payload",
        detail: "payload had neither pr_url nor complete owner/repo/number",
      },
    });
    return;
  }

  await emit({
    kind: "lifecycle",
    state: "started",
    payload: { ref },
  });

  try {
    const result = await reviewPr({
      ref,
      substrate: cfg.substrate,
      post: payload.post ?? cfg.postReviews ?? false,
      ...(payload.timeout_ms ? { timeoutMs: payload.timeout_ms } : {}),
      ...(cfg.lensConcurrency !== undefined
        ? { lensConcurrency: cfg.lensConcurrency }
        : {}),
      onLensComplete: async (lens) => {
        await emit({
          kind: "lifecycle",
          state: "progress",
          payload: { lens: lens.lens, findings: lens.findings.length, summary: lens.summary },
        });
      },
    });

    // Verdict envelope carries the substrate identity in `extensions` per
    // issue #14 acceptance — same persona on different substrates should
    // produce envelopes that differ ONLY in `extensions.substrate`, making
    // A/B comparison trivial for the operator.
    await emit(
      {
        kind: "prReview",
        verdict: result.verdict.decision,
        payload: { ref, verdict: result.verdict, posted: result.posted },
      },
      substrateExtensions,
    );

    // sage#16: post-failed is a lifecycle event, not a verdict outcome.
    // Recovery path is built by `workflow.ts` (the layer that already
    // owns persist + post); bridge just relays it on the envelope.
    //
    // dispatch.task.completed vs dispatch.task.failed contract
    // (Holly round 3, sage#27 finding #4): a task is `completed` when
    // it produced a verdict — even if every applicable lens errored.
    // `failed` is reserved for the case where no verdict could be
    // produced at all.
    const completedPublish = emit({
      kind: "lifecycle",
      state: "completed",
      payload: {
        ref,
        decision: result.verdict.decision,
        posted: result.posted,
      },
    });

    const publishes: Promise<void>[] = [completedPublish];
    if (result.postError) {
      publishes.push(
        emit(
          {
            kind: "dispatchOperational",
            state: "post-failed",
            payload: {
              ref,
              verdict: result.verdict,
              error: result.postError,
              recovery_path: result.recoveryPath,
            },
          },
          substrateExtensions,
        ),
      );
    }

    // `Promise.allSettled` so a NATS hiccup on one envelope can't
    // suppress the other — `Promise.all` would reject on first failure
    // and the dispatcher would never see `completed`, hanging until
    // its --wait expires.
    const settled = await Promise.allSettled(publishes);
    for (const s of settled) {
      if (s.status === "rejected") {
        log(
          `bridge: outcome publish failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
        );
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      await emit({
        kind: "lifecycle",
        state: "failed",
        payload: { ref, reason: "review-error", detail },
      });
    } catch (emitErr) {
      const em = emitErr instanceof Error ? emitErr.message : String(emitErr);
      log(`bridge: failed to emit dispatch.task.failed for ${env.id}: ${em}`);
    }
  }
}

/**
 * Narrow the Zod-refined task payload into a concrete PrRef without `!`
 * non-null assertions. Returns undefined when neither branch is satisfied
 * (the schema's refine layer should already reject these — this is the
 * compiler-visible guarantee).
 */
function resolvePrRef(payload: ReviewTaskPayload): PrRef | undefined {
  if (payload.pr_url) return parsePrRef(payload.pr_url);
  if (payload.owner && payload.repo && payload.number !== undefined) {
    return { owner: payload.owner, repo: payload.repo, number: payload.number };
  }
  return undefined;
}


/**
 * Stream NATS connection status events to the log so a transport hiccup
 * surfaces as a log line rather than an unhandled 'error' EventEmitter
 * crash. status() yields disconnect, reconnect, error, ldm (lameDuck),
 * update (server list), and pingTimer events.
 */
async function watchConnectionStatus(nc: NatsConnection): Promise<void> {
  try {
    for await (const s of nc.status()) {
      const detail = typeof s.data === "string" ? s.data : JSON.stringify(s.data);
      log(`bridge: nats ${s.type} — ${detail}`);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log(`bridge: nats status iterator ended: ${m}`);
  }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
