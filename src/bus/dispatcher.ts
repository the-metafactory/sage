import { randomUUID } from "node:crypto";
import type { Subscription } from "nats";

import { buildEnvelope, safeValidateEnvelope, type Envelope } from "./envelope.ts";
import {
  taskSubject,
  dispatchLifecycleWildcard,
  verdictWildcard,
} from "./subjects.ts";
import { connectNats } from "./connect.ts";
import { parsePrRef } from "../github/gh.ts";

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
  /** Set to `true` to ask the receiver to post the review. Default false. */
  post: boolean;
  /** Hard wait cap in seconds — exits non-zero if no completed/failed arrives. */
  waitSeconds: number;
  /**
   * Per-lens pi runner timeout (seconds) to forward to the daemon via
   * payload.timeout_ms. Daemon falls back to its own PI_TIMEOUT_MS / default
   * when this is absent.
   */
  timeoutSeconds?: number;
}

const td = new TextDecoder();
const te = new TextEncoder();

export interface BuildReviewTaskPayloadInput {
  prUrl: string;
  /** Boolean from CLI; only `true` → opt-in. `false` → omit field. */
  post: boolean;
  /** Optional per-lens pi timeout to forward to the daemon (seconds). */
  timeoutSeconds?: number;
}

/**
 * Shape of the dispatch envelope's payload. `post` is intentionally typed as
 * `true | undefined` (never `false`) — when the CLI flag is absent the field
 * is omitted so the bridge's `payload.post ?? cfg.postReviews` lookup falls
 * through to the daemon-side default. The trailing index signature keeps the
 * type assignable to `Record<string, unknown>` (which `buildEnvelope` accepts)
 * without losing the precise field types at use sites.
 */
export interface ReviewTaskPayload {
  pr_url: string;
  post?: true;
  timeout_ms?: number;
  [k: string]: unknown;
}

/**
 * Pure helper that shapes the dispatch envelope's payload. Extracted so the
 * fix for sage#8 is unit-testable without bringing up NATS.
 *
 * Semantic: `post` is OPT-IN only. The CLI's `--post` flag (default false)
 * sends `payload.post=true` when set, and OMITS the field otherwise.
 * Omitting lets the bridge's `payload.post ?? cfg.postReviews` lookup fall
 * through to the daemon-side default; sending an explicit `false` would
 * short-circuit past that default (??-coalesce treats false as a value).
 */
export function buildReviewTaskPayload(input: BuildReviewTaskPayloadInput): ReviewTaskPayload {
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
  });
  log(`connected ${opts.natsUrl}`);

  const correlationId = randomUUID();
  const taskEnvelope = buildEnvelope({
    source: opts.source,
    type: "tasks.code-review.typescript",
    correlationId,
    payload: buildReviewTaskPayload({
      prUrl: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      post: opts.post,
      ...(opts.timeoutSeconds ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    }),
  });
  const taskSubj = taskSubject({ org: opts.org }, "code-review.typescript");

  // Subscribe to lifecycle + verdict subjects BEFORE publishing so we cannot
  // miss a fast-completing daemon's reply. Filter by correlation_id so
  // concurrent reviews don't cross-talk.
  const lifecycleSub = nc.subscribe(dispatchLifecycleWildcard({ org: opts.org }));
  const verdictSub = nc.subscribe(verdictWildcard({ org: opts.org }));

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
      const detail = (env.payload as Record<string, unknown>) ?? {};
      if (Object.keys(detail).length > 0) {
        log(`  payload: ${JSON.stringify(detail)}`);
      }
      if (env.type === "dispatch.task.completed") {
        finish(0);
      } else if (env.type === "dispatch.task.failed") {
        finish(1);
      }
    });

    void consume(verdictSub, correlationId, (env, subject) => {
      log(`◀ ${subject} ${env.type}`);
      const payload = env.payload as Record<string, unknown>;
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

  log(`▶ publishing ${taskSubj} (id=${taskEnvelope.id}, correlation=${correlationId})`);
  nc.publish(taskSubj, te.encode(JSON.stringify(taskEnvelope)));

  const exitCode = await done;
  await nc.drain();
  return exitCode;
}

async function consume(
  sub: Subscription,
  correlationId: string,
  onMatch: (envelope: Envelope, subject: string) => void,
): Promise<void> {
  for await (const msg of sub) {
    let envelope: Envelope;
    try {
      const raw = JSON.parse(td.decode(msg.data));
      const parsed = safeValidateEnvelope(raw);
      if (!parsed.success) continue;
      envelope = parsed.data;
    } catch {
      continue;
    }
    if (envelope.correlation_id !== correlationId) continue;
    onMatch(envelope, msg.subject);
  }
}

const LOG_PREFIX = "[sage:dispatch]";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`${LOG_PREFIX} ${msg}`);
}
