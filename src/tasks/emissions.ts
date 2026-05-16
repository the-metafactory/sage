import {
  deriveLifecycleSubject,
  deriveSubject,
  STATE_TO_TYPE,
  taskSubject,
  verdictSubject,
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
       * `code.pr.review.` namespace.
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
 * `type`. Subjects and envelope types both come from myelin's canonical
 * helpers (`taskSubject`, `verdictSubject`, `deriveLifecycleSubject`,
 * `STATE_TO_TYPE`) — sage's local stack-aware shim was deleted once
 * myelin#157 landed the matching helpers upstream.
 *
 * `stack` is the IoAW operator-stack segment (sage#30, MY-101 Phase A).
 * Sage-default operators pass `"default"`; multi-stack operators set
 * `SAGE_STACK` and we propagate the configured value end-to-end. The
 * helpers accept `stack` as an optional trailing arg; sage always
 * supplies it explicitly to keep the 6-segment grammar at the bridge.
 */
export function describeEmission(
  org: string,
  stack: string,
  emission: Emission,
): { subject: string; type: string } {
  switch (emission.kind) {
    case "lifecycle":
      return {
        subject: deriveLifecycleSubject(org, emission.state, stack),
        type: STATE_TO_TYPE[emission.state],
      };
    case "dispatchOperational":
      // `post-failed` lives outside myelin's canonical `LifecycleState`
      // set (`deriveLifecycleSubject` rejects unknown states at the type
      // level). Build the subject via the lower-level `deriveSubject`
      // primitive — it validates `org` and `stack`, leaves the `type`
      // segments to the caller, and emits the canonical 6-segment shape.
      // Drop this branch once myelin#150 lands operational lifecycle
      // states upstream.
      return {
        subject: deriveSubject("local", org, `dispatch.task.${emission.state}`, stack),
        type: `dispatch.task.${emission.state}`,
      };
    case "prReview":
      return {
        subject: verdictSubject(org, "review", emission.verdict, stack),
        type: `code.pr.review.${emission.verdict}`,
      };
    case "task":
      return {
        subject: taskSubject(org, emission.capability, stack),
        type: `tasks.${emission.capability}`,
      };
  }
}
