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
import type { DispatchTaskPayload as _DispatchTaskPayload } from "./payload.ts";

/**
 * @deprecated Import `DispatchTaskPayload` directly from `./payload.ts`.
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
  });
  log(`connected ${opts.natsUrl}`);

  const correlationId = randomUUID();
  const taskEnvelope = buildEnvelope<_DispatchTaskPayload>({
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
      const payload = (env.payload as Record<string, unknown>) ?? {};

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
        const ref = payload.ref as
          | { owner: string; repo: string; number: number }
          | undefined;
        const errObj = payload.error as { message?: unknown } | string | undefined;
        const errorMsg =
          typeof errObj === "string"
            ? errObj
            : typeof errObj?.message === "string"
              ? errObj.message
              : "<no error message>";
        log(`  post-failed: ${errorMsg}`);
        if (ref) {
          const owner = sanitizeRefSegment(ref.owner);
          const repo = sanitizeRefSegment(ref.repo);
          const num = Number.isInteger(ref.number) && ref.number > 0 ? ref.number : 0;
          log(
            `  recover: cat ~/.config/sage/reviews/${owner}-${repo}-${num}.md | gh pr review ${num} --repo ${owner}/${repo} --body-file -`,
          );
        }
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

/**
 * Strip everything that isn't a safe ref-segment character before this
 * value gets interpolated into a printed shell command. The character
 * class mirrors `persistVerdict`'s on-disk-filename sanitizer so the
 * `cat` path we emit matches what's actually on disk.
 *
 * Defense in depth: `TaskPayloadSchema` already constrains `owner`/`repo`
 * via a regex, but this dispatcher consumes envelopes from the bus
 * directly and treats every field as untrusted at the trust boundary.
 * Catches malformed envelopes that bypass schema validation as well as
 * any future producer that publishes without using sage's own helpers.
 */
function sanitizeRefSegment(raw: string): string {
  if (typeof raw !== "string") return "_";
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "_";
}
