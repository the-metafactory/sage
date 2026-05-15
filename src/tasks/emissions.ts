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
       * When myelin adopts `post-failed` (or similar) into its
       * `LifecycleState` union, fold this case back into `kind: "lifecycle"`.
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
 * `dispatchOperational` is the one local case — `post-failed` is sage's
 * extension outside myelin's canonical `LifecycleState` set. Tracked for
 * upstream adoption.
 */
export function describeEmission(
  org: string,
  emission: Emission,
): { subject: string; type: string } {
  switch (emission.kind) {
    case "lifecycle":
      return lifecycleSubjectAndType(org, emission.state);
    case "dispatchOperational":
      return {
        subject: `local.${org}.dispatch.task.${emission.state}`,
        type: `dispatch.task.${emission.state}`,
      };
    case "prReview":
      return prVerdictSubjectAndType(org, "review", emission.verdict);
    case "task":
      return taskSubjectAndType(org, emission.capability);
  }
}
