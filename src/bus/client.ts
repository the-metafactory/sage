/**
 * Bus Client Module — encapsulation seam over NATS.
 *
 * Folds the prior `connect.ts` + `emit.ts` + bare `nc.subscribe()`
 * call sites into one `BusClient` Interface. Production has exactly
 * one Adapter (NATS); no in-memory Adapter ships today. Per
 * LANGUAGE.md this is an **encapsulation seam**, not a Port — if a
 * second Adapter (myelin `NATSTransport` migration, alternate
 * transport) lands later, that's when it gets promoted to a Port.
 *
 * Subscribe is synchronous-arming: by the time `subscribe()` returns,
 * the NATS SUB frame is on the wire. Callers can subscribe THEN
 * publish, race-free by program order — no thunk, no late-bound key
 * (sage#58 makes the race-freeness structural, not comment-enforced).
 *
 * `EnvelopeStream` is an `AsyncIterable<{envelope, subject}>` —
 * tests use plain async generators as fakes (`async function*() {
 * yield fakeEnvelope; }`) without standing up a Bus Client mock.
 */

import {
  connect,
  credsAuthenticator,
  type NatsConnection,
  type Subscription,
} from "nats";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  createEnvelope,
  safeDecodeEnvelope,
  validateEnvelope,
  type MyelinEnvelope,
  type Sovereignty,
} from "@the-metafactory/myelin";

const te = new TextEncoder();

/**
 * Transport-level publish input. The bus layer stays a thin
 * transport boundary — domain-specific shapes (TaskEnvelopeSpec
 * etc.) are adapted at the composer (dispatcher.ts), not imported
 * into the bus module. Symmetric with the prior `PublishInput` in
 * the deleted `emit.ts`.
 */
export interface PublishInput {
  readonly subject: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface SubscribedEnvelope {
  readonly envelope: MyelinEnvelope;
  readonly subject: string;
}

export interface EnvelopeStream extends AsyncIterable<SubscribedEnvelope> {
  /**
   * Idempotent. Triggered by for-await cleanup or by caller's
   * finally. Errors closing the subscription are logged, not thrown
   * — close runs in a finally block where re-throwing would mask the
   * outer error.
   */
  close(): Promise<void>;
}

export interface BusClient {
  /**
   * Subscribe is synchronous-arming: NATS SUB frame is on the wire
   * before this returns. Callers can subscribe THEN publish, race-
   * free by program order.
   */
  subscribe(subjectPattern: string): EnvelopeStream;

  /**
   * Publish one envelope. Returns the published envelope's `id`
   * (cortex#237 §5.x uses this value as `correlation_id` on every
   * emitted lifecycle / verdict envelope). The bus layer doesn't
   * know about task envelopes specifically — domain adapters
   * (`buildTaskEnvelopeSpec`) supply the subject + type + payload
   * triple via `PublishInput`.
   */
  publish(
    input: PublishInput,
    sovereignty: Sovereignty,
    source: string,
  ): Promise<string>;

  /**
   * Finally-drain. Idempotent. Drain errors are logged, never
   * thrown — close runs in cleanup paths where a throw would mask
   * the underlying error.
   */
  close(): Promise<void>;
}

export interface OpenBusClientOptions {
  readonly natsUrl: string;
  readonly credsFile?: string;
  readonly requireAuth?: boolean;
  readonly log: (msg: string) => void;
}

/**
 * Build a `BusClient` connected to NATS. Resolves the creds path,
 * applies the authenticator when present, and enforces the
 * `requireAuth` policy (refuse to connect without usable creds).
 *
 * Connect failures throw; subscribe / publish failures surface
 * through the returned client.
 */
export async function openBusClient(
  opts: OpenBusClientOptions,
): Promise<BusClient> {
  const nc = await connectNats(opts);
  return makeBusClient(nc, opts);
}

function makeBusClient(
  nc: NatsConnection,
  opts: OpenBusClientOptions,
): BusClient {
  let drained = false;

  return {
    subscribe(subjectPattern) {
      // `nc.subscribe()` arms the NATS SUB synchronously — by the
      // time it returns, the subscription is on the wire.
      const sub = nc.subscribe(subjectPattern);
      return makeEnvelopeStream(sub, opts.log);
    },

    async publish(input, sovereignty, source) {
      const envelope = createEnvelope({
        source,
        type: input.type,
        sovereignty,
        payload: input.payload,
      });

      const result = validateEnvelope(envelope);
      if (!result.valid) {
        const detail = result.errors
          .map((e) => `${e.field}: ${e.message}`)
          .join(", ");
        throw new Error(
          `refusing to publish invalid envelope on ${input.subject}: ${detail}`,
        );
      }

      try {
        nc.publish(input.subject, te.encode(JSON.stringify(envelope)));
        opts.log(`published ${input.subject} (${envelope.id})`);
        return envelope.id;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        opts.log(`publish failed for ${input.subject} (${envelope.id}): ${m}`);
        throw err;
      }
    },

    async close() {
      if (drained) return;
      drained = true;
      // Bound the graceful drain. sage#77: a quiet/half-open connection
      // (e.g. subscriptions whose async iterators were abandoned mid-flight)
      // could make `nc.drain()` hang, wedging the CLI so `process.exit` is
      // never reached. Race the drain against a 2s cap; on timeout the CLI
      // returns and `process.exit` tears the connection down anyway.
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          nc.drain().catch((err) => {
            const m = err instanceof Error ? err.message : String(err);
            opts.log(`drain failed during cleanup: ${m}`);
          }),
          new Promise<void>((resolve) => {
            capTimer = setTimeout(resolve, 2_000);
          }),
        ]);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        opts.log(`close failed during cleanup: ${m}`);
      } finally {
        // Clear the cap timer when drain wins the race — an un-cleared
        // pending timer keeps the event loop alive up to 2s even after
        // close() resolved (sage#78 review).
        if (capTimer) clearTimeout(capTimer);
      }
    },
  };
}

function makeEnvelopeStream(
  sub: Subscription,
  log: (msg: string) => void,
): EnvelopeStream {
  let closed = false;
  const closeOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      // `Subscription.unsubscribe()` returns void; nats.js handles
      // the underlying UNSUB frame. Awaiting in case a future
      // version returns a Promise.
      await Promise.resolve(sub.unsubscribe());
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log(`unsubscribe failed: ${m}`);
    }
  };
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<SubscribedEnvelope> {
      // try/finally so the NATS subscription is released when the
      // consumer breaks / returns out of `for await`. Without it,
      // an early-exit consumer would leak the subscription until
      // `close()` was explicitly invoked (sage#65 round-2
      // CodeQuality important).
      try {
        for await (const msg of sub) {
          if (closed) return;
          const envelope = safeDecodeEnvelope(msg.data, msg.subject, {
            onError: (reason, subject) =>
              log(`${reason} on ${subject ?? "?"}`),
          });
          if (!envelope) continue;
          yield { envelope, subject: msg.subject };
        }
      } finally {
        await closeOnce();
      }
    },
    close: closeOnce,
  };
}

function resolveCredsPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("~/")) return raw.replace(/^~/, homedir());
  return raw;
}

async function connectNats(
  opts: OpenBusClientOptions,
): Promise<NatsConnection> {
  const connectOpts: Parameters<typeof connect>[0] = { servers: opts.natsUrl };
  const credsPath = resolveCredsPath(
    opts.credsFile ?? process.env.NATS_CREDS_FILE,
  );

  if (credsPath && existsSync(credsPath)) {
    connectOpts.authenticator = credsAuthenticator(readFileSync(credsPath));
    opts.log(`using NATS creds at ${credsPath}`);
  } else if (opts.requireAuth) {
    const detail = credsPath
      ? `NATS_CREDS_FILE=${credsPath} does not exist`
      : "no NATS_CREDS_FILE / credsFile";
    throw new Error(
      `requireAuth=true but no usable NATS creds (${detail}); refusing to connect unauthenticated`,
    );
  } else if (credsPath) {
    opts.log(
      `NATS_CREDS_FILE=${credsPath} does not exist — connecting unauthenticated`,
    );
  } else {
    opts.log(`connecting unauthenticated (no NATS_CREDS_FILE / credsFile)`);
  }

  return connect(connectOpts);
}

/**
 * Pure transform — filters an envelope stream by `correlation_id`.
 * The thunk shape (rather than a plain string) lets the dispatcher
 * subscribe BEFORE publish without a race window: at subscribe time
 * the published id isn't known yet, so callers pass a closure that
 * reads the let-binding the publish step will populate. By the time
 * an envelope can arrive (the for-await yields per-message after the
 * publish round-trip), the binding is set.
 *
 * Race-freeness is now structural: program order requires
 * `await bus.publish(...)` to complete before any iterator yields
 * its first envelope; the thunk's read sees the published id by
 * construction (sage#58 lifts the prior `getPublishedEnvelopeId`
 * comment-enforced contract into a Module-level helper).
 */
export async function* filterByCorrelation(
  stream: AsyncIterable<SubscribedEnvelope>,
  correlationId: () => string | undefined,
): AsyncIterable<SubscribedEnvelope> {
  for await (const item of stream) {
    const id = correlationId();
    if (id === undefined) continue;
    if (item.envelope.correlation_id !== id) continue;
    yield item;
  }
}
