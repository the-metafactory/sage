import { describe, expect, test } from "bun:test";

import { describeEmission } from "../../src/tasks/emissions.ts";

/**
 * `describeEmission` lock — asserts the (subject, type) pair sage emits
 * for each `Emission.kind`. The `dispatchOperational` branch is the
 * load-bearing one to cover (Holly review on PR#39): it routes through
 * myelin's lower-level `deriveSubject` primitive rather than the
 * higher-level lifecycle helper (because `post-failed` lives outside
 * myelin's canonical `LifecycleState` set). A regression in
 * `deriveSubject`'s output format would silently change sage's wire
 * shape — this test fails before that ships.
 *
 * The other three branches are simple arg-order pass-throughs to
 * `deriveLifecycleSubject` / `verdictSubject` / `taskSubject`. Covered
 * for completeness so the file is the one place that documents the
 * subject ⇄ type pairing per emission kind.
 */
const ORG = "metafactory";
const STACK = "default";

describe("describeEmission", () => {
  test("lifecycle — canonical LifecycleState produces 6-segment dispatch subject", () => {
    const result = describeEmission(ORG, STACK, {
      kind: "lifecycle",
      state: "completed",
      payload: { taskId: "abc" },
    });
    expect(result.subject).toBe("local.metafactory.default.dispatch.task.completed");
    expect(result.type).toBe("dispatch.task.completed");
  });

  test("dispatchOperational — post-failed routes through deriveSubject (the regression-sensitive path)", () => {
    const result = describeEmission(ORG, STACK, {
      kind: "dispatchOperational",
      state: "post-failed",
      payload: { reason: "github 502" },
    });
    expect(result.subject).toBe("local.metafactory.default.dispatch.task.post-failed");
    expect(result.type).toBe("dispatch.task.post-failed");
  });

  test("dispatchOperational — non-default stack flows through the same 6-segment shape", () => {
    const result = describeEmission(ORG, "research", {
      kind: "dispatchOperational",
      state: "post-failed",
      payload: {},
    });
    expect(result.subject).toBe("local.metafactory.research.dispatch.task.post-failed");
    expect(result.type).toBe("dispatch.task.post-failed");
  });

  test("prReview — verdict subject + type pair stays aligned per discriminant", () => {
    const result = describeEmission(ORG, STACK, {
      kind: "prReview",
      verdict: "approved",
      payload: {},
    });
    expect(result.subject).toBe("local.metafactory.default.code.pr.review.approved");
    expect(result.type).toBe("code.pr.review.approved");
  });

  test("task — capability flows into the 6-segment task subject", () => {
    const result = describeEmission(ORG, STACK, {
      kind: "task",
      capability: "code-review.typescript",
      payload: {},
    });
    expect(result.subject).toBe("local.metafactory.default.tasks.code-review.typescript");
    expect(result.type).toBe("tasks.code-review.typescript");
  });
});
