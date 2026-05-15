import { describe, expect, test } from "bun:test";

import {
  broadcastTaskSubject,
  directTaskSubject,
  deriveLifecycleSubject,
  verdictSubject,
  taskSubject,
  deriveLifecycleWildcard,
  verdictWildcard,
  DEFAULT_STACK,
  validateStack,
} from "../src/tasks/subjects.ts";

/**
 * Sage's IoAW MY-101 Phase A subject grammar (sage#30) — 5+ segments
 * with `{stack}` at position 3. These helpers wrap myelin's encoder
 * locally until myelin#151 ships stack-aware upstream helpers; tests
 * lock the canonical form so the cedar↔sage protocol stays in sync.
 *
 *   - Inbound broadcast: `local.{org}.{stack}.tasks.code-review.>`
 *   - Inbound direct:    `local.{org}.{stack}.tasks.@did-mf-sage.>`
 *   - Outbound lifecycle: `local.{org}.{stack}.dispatch.task.{state}`
 *   - Outbound verdict:   `local.{org}.{stack}.code.pr.review.{decision}`
 */
const ORG = "metafactory";
const STACK = DEFAULT_STACK;

describe("sage subject grammar (stack-aware, IoAW Phase A)", () => {
  test("broadcastTaskSubject('default', 'code-review') yields the Phase-A canonical form", () => {
    expect(broadcastTaskSubject(ORG, STACK, "code-review")).toBe(
      "local.metafactory.default.tasks.code-review.>",
    );
  });

  test("directTaskSubject('default', 'did:mf:sage') yields the Phase-A direct form", () => {
    expect(directTaskSubject(ORG, STACK, "did:mf:sage")).toBe(
      "local.metafactory.default.tasks.@did-mf-sage.>",
    );
  });

  test("taskSubject('default', 'code-review.typescript') is the dispatch terminal subject", () => {
    expect(taskSubject(ORG, STACK, "code-review.typescript")).toBe(
      "local.metafactory.default.tasks.code-review.typescript",
    );
  });

  const LIFECYCLE_PHASES = ["started", "progress", "completed", "failed"];
  test.each(LIFECYCLE_PHASES.map((p) => [p]))(
    "deriveLifecycleSubject('default', '%s') yields the canonical dispatch subject",
    (phase) => {
      expect(deriveLifecycleSubject(ORG, STACK, phase)).toBe(
        `local.metafactory.default.dispatch.task.${phase}`,
      );
    },
  );

  const REVIEW_DECISIONS = ["approved", "changes-requested", "commented"];
  test.each(REVIEW_DECISIONS.map((d) => [d]))(
    "verdictSubject('default', 'review', '%s') yields the canonical pr-review subject",
    (decision) => {
      expect(verdictSubject(ORG, STACK, "review", decision)).toBe(
        `local.metafactory.default.code.pr.review.${decision}`,
      );
    },
  );

  test("wildcards used by the dispatcher subscription side", () => {
    expect(deriveLifecycleWildcard(ORG, STACK)).toBe(
      "local.metafactory.default.dispatch.task.>",
    );
    expect(verdictWildcard(ORG, STACK, "review")).toBe(
      "local.metafactory.default.code.pr.review.>",
    );
  });

  test("multi-stack: 'research' stack flows through every helper", () => {
    expect(broadcastTaskSubject(ORG, "research", "code-review")).toBe(
      "local.metafactory.research.tasks.code-review.>",
    );
    expect(verdictSubject(ORG, "research", "review", "approved")).toBe(
      "local.metafactory.research.code.pr.review.approved",
    );
  });

  test("validateStack rejects invalid segments (sage#30)", () => {
    expect(() => validateStack("Default")).toThrow(/must match/);
    expect(() => validateStack("default!")).toThrow(/must match/);
    expect(() => validateStack("")).toThrow(/must match/);
    expect(validateStack("default")).toBe("default");
    expect(validateStack("research")).toBe("research");
    expect(validateStack("multi-stack-name")).toBe("multi-stack-name");
  });
});
