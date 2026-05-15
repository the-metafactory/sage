import { describe, expect, test } from "bun:test";

import {
  broadcastTaskSubject,
  directTaskSubject,
  deriveLifecycleSubject,
  verdictSubject,
  taskSubject,
  deriveLifecycleWildcard,
  verdictWildcard,
} from "@the-metafactory/myelin";

/**
 * Sage's subject grammar was previously hand-rolled in `src/bus/subjects.ts`
 * — deleted when sage adopted `@the-metafactory/myelin` v0.2. These tests
 * lock the sage-specific subject shapes against the upstream helpers:
 *
 *   - Inbound broadcast: `local.{org}.tasks.code-review.>`
 *   - Inbound direct:    `local.{org}.tasks.@did-mf-sage.>`
 *   - Outbound lifecycle: `local.{org}.dispatch.task.{state}`
 *   - Outbound verdict:   `local.{org}.code.pr.review.{decision}`
 *
 * Drift in any of these breaks the cedar↔sage protocol.
 */
const ORG = "metafactory";

describe("sage subject grammar (via myelin helpers)", () => {
  test("broadcastTaskSubject('code-review') matches the inbound broadcast pattern", () => {
    expect(broadcastTaskSubject(ORG, "code-review")).toBe(
      "local.metafactory.tasks.code-review.>",
    );
  });

  test("directTaskSubject('did:mf:sage') matches the inbound direct pattern", () => {
    expect(directTaskSubject(ORG, "did:mf:sage")).toBe(
      "local.metafactory.tasks.@did-mf-sage.>",
    );
  });

  test("taskSubject('code-review.typescript') is the dispatch terminal subject", () => {
    expect(taskSubject(ORG, "code-review.typescript")).toBe(
      "local.metafactory.tasks.code-review.typescript",
    );
  });

  // Table-driven so adding a phase or verdict (sage R29 #4) means one
  // entry, not a copy-pasted assertion block.
  const LIFECYCLE_PHASES = ["started", "progress", "completed", "failed"] as const;
  test.each(LIFECYCLE_PHASES)(
    "deriveLifecycleSubject('%s') yields the canonical dispatch subject",
    (phase) => {
      expect(deriveLifecycleSubject(ORG, phase)).toBe(
        `local.metafactory.dispatch.task.${phase}`,
      );
    },
  );

  const REVIEW_DECISIONS = ["approved", "changes-requested", "commented"] as const;
  test.each(REVIEW_DECISIONS)(
    "verdictSubject('review', '%s') yields the canonical pr-review subject",
    (decision) => {
      expect(verdictSubject(ORG, "review", decision)).toBe(
        `local.metafactory.code.pr.review.${decision}`,
      );
    },
  );

  test("wildcards used by the dispatcher subscription side", () => {
    expect(deriveLifecycleWildcard(ORG)).toBe(
      "local.metafactory.dispatch.task.>",
    );
    expect(verdictWildcard(ORG, "review")).toBe(
      "local.metafactory.code.pr.review.>",
    );
  });
});
