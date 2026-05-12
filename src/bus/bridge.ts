import { connect, type NatsConnection, type Subscription } from "nats";
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
import { parsePrRef } from "../github/gh.ts";
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
      throw new Error("Semaphore released more times than acquired");
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
  const nc = await connect({ servers: cfg.natsUrl });
  const subjects: SubjectConfig = { org: cfg.org, did: cfg.did };

  const broadcast = nc.subscribe(broadcastSubject(subjects));
  const direct = nc.subscribe(directSubject(subjects));

  const concurrencyLimit = cfg.maxConcurrentTasks ?? 3;
  const sem = new Semaphore(concurrencyLimit);

  log(`bridge: connected ${cfg.natsUrl}`);
  log(`bridge: subscribed ${broadcastSubject(subjects)}`);
  log(`bridge: subscribed ${directSubject(subjects)}`);
  log(`bridge: maxConcurrentTasks=${concurrencyLimit}`);

  const onLoopFailure = (which: string) => (err: unknown) => {
    const m = err instanceof Error ? err.message : String(err);
    log(`bridge: FATAL — ${which} consumer loop died: ${m}`);
    // Exit non-zero so launchd / systemd restart the daemon cleanly.
    // The KeepAlive contract assumes silent loop death = bug, not a
    // graceful drain.
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
  const ref = payload.pr_url
    ? parsePrRef(payload.pr_url)
    : { owner: payload.owner!, repo: payload.repo!, number: payload.number! };

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
  nc.publish(subject, te.encode(JSON.stringify(envelope)));
  log(`bridge: published ${subject} (${envelope.id})`);
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
