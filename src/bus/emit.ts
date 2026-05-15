import type { NatsConnection } from "nats";
import {
  createEnvelope,
  validateEnvelope,
  deriveLifecycleSubject,
  verdictSubject,
  taskSubject,
  STATE_TO_TYPE,
  type LifecycleState,
  type Sovereignty,
} from "@the-metafactory/myelin";

const te = new TextEncoder();

/**
 * Typed emission descriptor. Discriminated union: each `kind` derives BOTH
 * the NATS subject AND the envelope `type` from the same data, so a caller
 * cannot publish on `code.pr.review.approved` while stamping
 * `type: "code.pr.review.changes-requested"` on the envelope. The
 * descriptor is the single source of truth for outbound consistency.
 *
 * Four families covered today; add cases here when a new family is
 * introduced so all call sites (bridge, dispatcher) pick it up at once.
 */
export type Emission =
  | {
      kind: "lifecycle";
      state: LifecycleState;
      payload: Record<string, unknown>;
    }
  | {
      /**
       * Operational lifecycle signal outside myelin's canonical
       * `LifecycleState` set. Currently used for `post-failed` — the
       * GitHub-post step failed after the review verdict was already
       * published. Lives in the dispatch lifecycle namespace (not
       * `code.pr.review.*`) because it describes what happened to the
       * envelope, not the review verdict itself.
       *
       * When myelin adopts `post-failed` (or similar) into its
       * `LifecycleState` union, fold this back into `kind: "lifecycle"`.
       */
      kind: "dispatchOperational";
      state: "post-failed";
      payload: Record<string, unknown>;
    }
  | {
      /**
       * Pull-request review verdict. Named `prReview` (not generic
       * `verdict`) because the derived envelope type hard-codes the
       * `code.pr.review.` namespace — extending to non-PR verdict
       * domains requires a new `kind`, not a new `family` value.
       */
      kind: "prReview";
      verdict: "approved" | "changes-requested" | "commented";
      payload: Record<string, unknown>;
    }
  | {
      kind: "task";
      /** Capability dotted-path, e.g. `"code-review.typescript"`. */
      capability: string;
      payload: Record<string, unknown>;
    };

export interface EmitterOptions {
  nc: NatsConnection;
  /** Org segment used by all subject helpers. */
  org: string;
  /** Envelope `source` field. Stamped on every emission from this emitter. */
  source: string;
  /** Sovereignty block stamped on every emission. */
  sovereignty: Sovereignty;
  /** Optional logger. Receives one message per publish attempt (success or failure). */
  log?: (msg: string) => void;
}

export interface Emitter {
  (
    emission: Emission,
    correlationId?: string,
    extensions?: Record<string, unknown>,
  ): Promise<void>;
}

function deriveSubjectAndType(
  org: string,
  emission: Emission,
): { subject: string; type: string } {
  switch (emission.kind) {
    case "lifecycle":
      return {
        subject: deriveLifecycleSubject(org, emission.state),
        type: STATE_TO_TYPE[emission.state],
      };
    case "dispatchOperational":
      // `post-failed` is a lifecycle-shaped subject that myelin doesn't
      // model in its canonical LifecycleState set. Sage-local; tracked
      // for upstream adoption.
      return {
        subject: `local.${org}.dispatch.task.${emission.state}`,
        type: `dispatch.task.${emission.state}`,
      };
    case "prReview":
      return {
        subject: verdictSubject(org, "review", emission.verdict),
        type: `code.pr.review.${emission.verdict}`,
      };
    case "task":
      return {
        subject: taskSubject(org, emission.capability),
        type: `tasks.${emission.capability}`,
      };
  }
}

/**
 * Outbound-envelope emitter factory. Each emission goes through one
 * `Emission` descriptor: the function derives subject + envelope type
 * together, builds the envelope through myelin, validates it, then
 * publishes.
 *
 * Single source of truth for outbound contract — signing, alternate
 * codecs, transport migration land here.
 */
export function makeEmitter(opts: EmitterOptions): Emitter {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function emit(emission, correlationId, extensions): Promise<void> {
    const { subject, type } = deriveSubjectAndType(opts.org, emission);

    const envelope = createEnvelope({
      source: opts.source,
      type,
      sovereignty: opts.sovereignty,
      payload: emission.payload,
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
