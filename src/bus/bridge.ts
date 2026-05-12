import { connect, credsAuthenticator, type NatsConnection, type Subscription } from "nats";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";

import {
  buildEnvelope,
  deriveSubject,
  safeValidateEnvelope,
  type Envelope,
} from "./envelope.ts";
import {
  broadcastSubject,
  directSubject,
  dispatchSubject,
  verdictSubject,
  type SubjectConfig,
} from "./subjects.ts";
import { parsePrRef, type PrRef } from "../github/gh.ts";
import { reviewPr } from "../lenses/workflow.ts";

const td = new TextDecoder();
const te = new TextEncoder();

/**
 * Payload schema for a code-review task envelope.
 * Sage accepts either explicit `owner/repo/number` or a `pr_url`.
 */
export const ReviewTaskPayloadSchema = z
  .object({
    pr_url: z.string().url().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    number: z.number().int().positive().optional(),
    post: z.boolean().optional(),
  })
  .refine((p) => Boolean(p.pr_url) || (Boolean(p.owner) && Boolean(p.repo) && Boolean(p.number)), {
    message: "payload must contain either pr_url or (owner, repo, number)",
  });

export type ReviewTaskPayload = z.infer<typeof ReviewTaskPayloadSchema>;

export interface BridgeConfig {
  natsUrl: string;
  org: string;
  source: string;
  did: string;
  capabilities?: readonly string[];
  /** Default to true; set false to log-only for dry-run testing. */
  postReviews?: boolean;
  /**
   * Max concurrent reviews. Each review spawns a `pi` subprocess and competes
   * for LLM API rate limit + memory; unbounded is dangerous under load.
   * Defaults to 3. Phase 2 should replace this in-process gate with a NATS
   * JetStream consumer group `max_ack_pending`.
   */
  maxConcurrentTasks?: number;
  /**
   * Path to a NATS user `.creds` file (nsc-generated). When set, the bridge
   * authenticates with the broker. Falls back to `NATS_CREDS_FILE` env var.
   * Unauthenticated when neither is set (dev / local broker only).
   */
  credsFile?: string;
  /**
   * NATS queue-group name for the broadcast + direct subscriptions. Multiple
   * Sage instances joining the same group share work via competing-consumer
   * semantics (only one delivery per message). Defaults to `sage-review`.
   */
  queueGroup?: string;
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
  const connectOpts: Parameters<typeof connect>[0] = { servers: cfg.natsUrl };

  const credsPath = resolveCredsPath(cfg.credsFile ?? process.env.NATS_CREDS_FILE);
  if (credsPath) {
    connectOpts.authenticator = credsAuthenticator(readFileSync(credsPath));
    log(`bridge: using NATS creds at ${credsPath}`);
  } else {
    log(`bridge: connecting unauthenticated (no NATS_CREDS_FILE / cfg.credsFile)`);
  }

  const nc = await connect(connectOpts);
  // Register connection-level event listeners BEFORE any subscribe/publish.
  // The nats.js client emits 'error' on the connection (not via thrown
  // exceptions) for transport-level failures during fire-and-forget
  // publish, plus normal status events for reconnect cycles. Without an
  // 'error' listener Node.js's EventEmitter would throw and crash the
  // daemon.
  void watchConnectionStatus(nc);

  const subjects: SubjectConfig = { org: cfg.org, did: cfg.did };
  const queue = cfg.queueGroup ?? "sage-review";

  const broadcast = nc.subscribe(broadcastSubject(subjects), { queue });
  const direct = nc.subscribe(directSubject(subjects), { queue });

  const concurrencyLimit = cfg.maxConcurrentTasks ?? 3;
  const sem = new Semaphore(concurrencyLimit);

  log(`bridge: connected ${cfg.natsUrl}`);
  log(`bridge: subscribed ${broadcastSubject(subjects)} (queue=${queue})`);
  log(`bridge: subscribed ${directSubject(subjects)} (queue=${queue})`);
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
    let envelope: Envelope;
    try {
      const raw = JSON.parse(td.decode(msg.data));
      const parsed = safeValidateEnvelope(raw);
      if (!parsed.success) {
        log(`bridge: rejected envelope on ${msg.subject}: ${parsed.error.message}`);
        continue;
      }
      envelope = parsed.data;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log(`bridge: bad payload on ${msg.subject}: ${m}`);
      continue;
    }

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

async function handleTask(env: Envelope, cfg: BridgeConfig, nc: NatsConnection): Promise<void> {
  const payloadResult = ReviewTaskPayloadSchema.safeParse(env.payload);
  if (!payloadResult.success) {
    await publish(
      nc,
      buildEnvelope({
        source: cfg.source,
        type: "dispatch.task.failed",
        correlationId: env.correlation_id ?? env.id,
        payload: { reason: "invalid-payload", detail: payloadResult.error.message },
      }),
      dispatchSubject({ org: cfg.org }, "failed"),
    );
    return;
  }
  const payload = payloadResult.data;
  const ref = resolvePrRef(payload);
  if (!ref) {
    // Defensive — Zod's `.refine()` does not narrow the output type, so the
    // compiler cannot prove non-null on `owner/repo/number`. The schema
    // refinement above already guarantees at least one branch is present.
    // If a future refactor breaks that, this catches it at the boundary
    // instead of producing an undefined-ref TypeError downstream.
    await publish(
      nc,
      buildEnvelope({
        source: cfg.source,
        type: "dispatch.task.failed",
        correlationId: env.correlation_id ?? env.id,
        payload: {
          reason: "invalid-payload",
          detail: "payload had neither pr_url nor complete owner/repo/number",
        },
      }),
      dispatchSubject({ org: cfg.org }, "failed"),
    );
    return;
  }

  await publish(
    nc,
    buildEnvelope({
      source: cfg.source,
      type: "dispatch.task.started",
      correlationId: env.correlation_id ?? env.id,
      payload: { ref },
    }),
    dispatchSubject({ org: cfg.org }, "started"),
  );

  try {
    const result = await reviewPr({
      ref,
      post: payload.post ?? cfg.postReviews ?? false,
      onLensComplete: async (lens) => {
        await publish(
          nc,
          buildEnvelope({
            source: cfg.source,
            type: "dispatch.task.progress",
            correlationId: env.correlation_id ?? env.id,
            payload: { lens: lens.lens, findings: lens.findings.length, summary: lens.summary },
          }),
          dispatchSubject({ org: cfg.org }, "progress"),
        );
      },
    });

    await publish(
      nc,
      buildEnvelope({
        source: cfg.source,
        type: `code.pr.review.${result.verdict.decision}`,
        correlationId: env.correlation_id ?? env.id,
        payload: { ref, verdict: result.verdict, posted: result.posted },
      }),
      verdictSubject({ org: cfg.org }, result.verdict.decision),
    );

    await publish(
      nc,
      buildEnvelope({
        source: cfg.source,
        type: "dispatch.task.completed",
        correlationId: env.correlation_id ?? env.id,
        payload: { ref, decision: result.verdict.decision },
      }),
      dispatchSubject({ org: cfg.org }, "completed"),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await publish(
      nc,
      buildEnvelope({
        source: cfg.source,
        type: "dispatch.task.failed",
        correlationId: env.correlation_id ?? env.id,
        payload: { ref, reason: "review-error", detail },
      }),
      dispatchSubject({ org: cfg.org }, "failed"),
    );
  }
}

async function publish(
  nc: NatsConnection,
  envelope: Envelope,
  subjectOverride?: string,
): Promise<void> {
  const subject = subjectOverride ?? deriveSubject(envelope);
  try {
    nc.publish(subject, te.encode(JSON.stringify(envelope)));
    log(`bridge: published ${subject} (${envelope.id})`);
  } catch (err) {
    // nats.js publish is fire-and-forget; failures surface synchronously
    // only when the client refuses (e.g., over max payload size or after
    // close). Connection-drop failures fire as `'error'` events on the
    // connection, not exceptions here — those need a separate listener.
    // Phase 2: switch lifecycle envelopes to JetStream publish with ack.
    const m = err instanceof Error ? err.message : String(err);
    log(`bridge: publish failed for ${subject} (${envelope.id}): ${m}`);
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

function resolveCredsPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("~/")) return raw.replace(/^~/, homedir());
  return raw;
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
