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

  test("deriveLifecycleSubject covers the lifecycle phases sage emits", () => {
    expect(deriveLifecycleSubject(ORG, "started")).toBe(
      "local.metafactory.dispatch.task.started",
    );
    expect(deriveLifecycleSubject(ORG, "progress")).toBe(
      "local.metafactory.dispatch.task.progress",
    );
    expect(deriveLifecycleSubject(ORG, "completed")).toBe(
      "local.metafactory.dispatch.task.completed",
    );
    expect(deriveLifecycleSubject(ORG, "failed")).toBe(
      "local.metafactory.dispatch.task.failed",
    );
  });

  test("verdictSubject('review', verdict) covers the three review decisions", () => {
    expect(verdictSubject(ORG, "review", "approved")).toBe(
      "local.metafactory.code.pr.review.approved",
    );
    expect(verdictSubject(ORG, "review", "changes-requested")).toBe(
      "local.metafactory.code.pr.review.changes-requested",
    );
    expect(verdictSubject(ORG, "review", "commented")).toBe(
      "local.metafactory.code.pr.review.commented",
    );
  });

  test("wildcards used by the dispatcher subscription side", () => {
    expect(deriveLifecycleWildcard(ORG)).toBe(
      "local.metafactory.dispatch.task.>",
    );
    expect(verdictWildcard(ORG, "review")).toBe(
      "local.metafactory.code.pr.review.>",
    );
  });
});
