import {
  lifecycleSubjectAndType,
  prVerdictSubjectAndType,
  taskSubjectAndType,
  type LifecycleState,
} from "@the-metafactory/myelin";

/**
 * Sage-side emission taxonomy. Discriminated union: each `kind` derives
 * BOTH the NATS subject AND the envelope `type` from the same data, so a
 * caller cannot publish on `code.pr.review.approved` while stamping
 * `type: "code.pr.review.changes-requested"` on the envelope.
 *
 * Owned by `src/tasks/` (sage's review-domain module), NOT by
 * `src/bus/emit.ts` — review semantics live in the domain layer; the bus
 * layer stays a thin transport boundary (sage PR#29 architecture review).
 *
 * Four families today; add a new `kind` (not a new `family` value) when
 * a non-review verdict domain appears.
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
       * published. Lives in the dispatch lifecycle namespace because it
       * describes what happened to the envelope, not the review verdict
       * itself.
       *
       * TODO: remove this `kind` once myelin#150 lands — fold the state
       * back into `kind: "lifecycle"`. The local wire grammar in
       * `describeEmission` is the temporary protocol adapter sage carries
       * until upstream gains an operational-lifecycle helper.
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

/**
 * Resolve an `Emission` descriptor to its NATS `subject` and envelope
 * `type`. Lifecycle / task / prReview all delegate to myelin's
 * `subjectAndType` helpers (myelin#144) so cedar+sage share one source of
 * truth for the wire grammar.
 *
 * `dispatchOperational` delegates to a local adapter (`operationalLifecycleSubjectAndType`)
 * — sage's `post-failed` phase has no myelin equivalent yet (myelin#150).
 * Both the local case AND the adapter delete when upstream lands.
 */
export function describeEmission(
  org: string,
  emission: Emission,
): { subject: string; type: string } {
  switch (emission.kind) {
    case "lifecycle":
      return lifecycleSubjectAndType(org, emission.state);
    case "dispatchOperational":
      return operationalLifecycleSubjectAndType(org, emission.state);
    case "prReview":
      return prVerdictSubjectAndType(org, "review", emission.verdict);
    case "task":
      return taskSubjectAndType(org, emission.capability);
  }
}

/**
 * Temporary protocol adapter for operational lifecycle states sage emits
 * that aren't yet in myelin's `LifecycleState` union (currently:
 * `post-failed`). Mirrors the `local.{org}.dispatch.task.{state}` /
 * `dispatch.task.{state}` shape that `lifecycleSubjectAndType` uses
 * upstream, so the wire format is consistent today.
 *
 * **Remove this function** (and the `dispatchOperational` kind) once
 * myelin#150 ships — `kind: "lifecycle"` will cover `post-failed`
 * natively via `lifecycleSubjectAndType`. The function-level isolation
 * here makes the removal a one-file change instead of an inline-case
 * hunt.
 */
function operationalLifecycleSubjectAndType(
  org: string,
  state: "post-failed",
): { subject: string; type: string } {
  return {
    subject: `local.${org}.dispatch.task.${state}`,
    type: `dispatch.task.${state}`,
  };
}
