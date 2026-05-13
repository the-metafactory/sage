import { connect, credsAuthenticator, type Subscription } from "nats";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  buildEnvelope,
  safeValidateEnvelope,
  type Envelope,
} from "../bus/envelope.ts";
import {
  taskSubject,
  dispatchLifecycleWildcard,
  verdictWildcard,
} from "../bus/subjects.ts";
import { resolveCredsPath } from "../bus/creds.ts";
import { parsePrRef } from "../github/gh.ts";

/**
 * Publish a code-review task envelope to the Myelin bus and wait for the
 * verdict + lifecycle envelopes to come back. This is the bus-driven
 * counterpart to `sage review` — instead of running the review in-process,
 * it asks a running Sage daemon to do it via NATS.
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

export async function dispatchReview(opts: DispatchOptions): Promise<number> {
  const ref = parsePrRef(opts.prRef);

  const connectOpts: Parameters<typeof connect>[0] = { servers: opts.natsUrl };
  const credsPath = resolveCredsPath(opts.credsFile ?? process.env.NATS_CREDS_FILE);
  if (credsPath) {
    connectOpts.authenticator = credsAuthenticator(readFileSync(credsPath));
    log(`dispatch: using NATS creds at ${credsPath}`);
  }
  const nc = await connect(connectOpts);
  log(`dispatch: connected ${opts.natsUrl}`);

  const correlationId = randomUUID();
  const taskEnvelope = buildEnvelope({
    source: opts.source,
    type: "tasks.code-review.typescript",
    correlationId,
    payload: {
      pr_url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      post: opts.post,
      ...(opts.timeoutSeconds ? { timeout_ms: opts.timeoutSeconds * 1000 } : {}),
    },
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
      log(`dispatch: timed out after ${opts.waitSeconds}s — no completed/failed envelope received`);
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

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`[sage:dispatch] ${msg}`);
}
