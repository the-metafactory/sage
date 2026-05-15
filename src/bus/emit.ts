import type { NatsConnection } from "nats";
import {
  createEnvelope,
  validateEnvelope,
  type Sovereignty,
} from "@the-metafactory/myelin";

const te = new TextEncoder();

/**
 * Generic envelope publisher input. Callers supply the resolved `subject`
 * and envelope `type` — domain-specific subject/type derivation lives in
 * `src/tasks/emissions.ts` (sage review #2 PR#29: bus layer stays a thin
 * transport boundary; review/task taxonomy belongs to the domain module).
 */
export interface PublishInput {
  subject: string;
  type: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  extensions?: Record<string, unknown>;
}

export interface EmitterOptions {
  nc: NatsConnection;
  /** Envelope `source` field. Stamped on every emission from this emitter. */
  source: string;
  /** Sovereignty block stamped on every emission. */
  sovereignty: Sovereignty;
  /** Optional logger. Receives one message per publish attempt (success or failure). */
  log?: (msg: string) => void;
}

export interface Emitter {
  (input: PublishInput): Promise<void>;
}

/**
 * Build a transport-level publisher closing over `source` + `sovereignty`
 * + connection. Domain code (`src/tasks/emissions.ts`) resolves the
 * subject/type pair from a typed descriptor, then hands the result here.
 *
 * Single source of truth for outbound contract — signing, alternate
 * codecs, transport migration land here.
 */
export function makeEmitter(opts: EmitterOptions): Emitter {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function emit(input): Promise<void> {
    const { subject, type, payload, correlationId, extensions } = input;

    const envelope = createEnvelope({
      source: opts.source,
      type,
      sovereignty: opts.sovereignty,
      payload,
      ...(correlationId ? { correlation_id: correlationId } : {}),
      ...(extensions ? { extensions } : {}),
    });

    // Validate at the outbound boundary. Matches the pre-myelin
    // `buildEnvelope` contract (Zod parse before return).
    const result = validateEnvelope(envelope);
    if (!result.valid) {
      const detail = result.errors
        .map((e) => `${e.field}: ${e.message}`)
        .join(", ");
      throw new Error(
        `refusing to publish invalid envelope on ${subject}: ${detail}`,
      );
    }

    try {
      opts.nc.publish(subject, te.encode(JSON.stringify(envelope)));
      opts.log?.(`published ${subject} (${envelope.id})`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      opts.log?.(`publish failed for ${subject} (${envelope.id}): ${m}`);
      throw err;
    }
  };
}
