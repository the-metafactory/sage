import { describe, expect, test } from "bun:test";

import {
  broadcastTaskSubject,
  deriveLifecycleSubject,
  deriveLifecycleWildcard,
  subjectMatchesPattern,
  taskSubject,
  verdictSubject,
  verdictWildcard,
} from "@the-metafactory/myelin";

const ORG = "metafactory";

/**
 * Cross-stack isolation regression test. Locked at sage#30 / Holly PR#31
 * back when sage carried a local stack-aware shim; the shim was deleted
 * once myelin#157 shipped the helpers upstream, but the property is
 * still sage-load-bearing: a sage daemon subscribed to one stack's
 * wildcard MUST NOT receive a publish from another stack. This test
 * verifies that property against myelin's canonical helpers so any
 * upstream regression in subject grammar fails sage CI loudly.
 *
 * Uses `subjectMatchesPattern` (myelin's NATS subject matcher) rather
 * than naive string compare — the assertion follows NATS wildcard
 * semantics, not literal equality.
 */
describe("cross-stack isolation against myelin helpers", () => {
  test("broadcastTaskSubject — research traffic does not reach default daemons", () => {
    const defaultBroadcast = broadcastTaskSubject(ORG, "code-review", "default");
    const researchBroadcast = broadcastTaskSubject(ORG, "code-review", "research");
    const defaultTask = taskSubject(ORG, "code-review.typescript", "default");
    const researchTask = taskSubject(ORG, "code-review.typescript", "research");

    expect(subjectMatchesPattern(defaultTask, defaultBroadcast)).toBe(true);
    expect(subjectMatchesPattern(researchTask, researchBroadcast)).toBe(true);

    expect(subjectMatchesPattern(researchTask, defaultBroadcast)).toBe(false);
    expect(subjectMatchesPattern(defaultTask, researchBroadcast)).toBe(false);
  });

  test("deriveLifecycleWildcard — cross-stack lifecycle traffic is isolated", () => {
    const defaultLifecycleWild = deriveLifecycleWildcard(ORG, "default");
    const researchLifecycleSubject = deriveLifecycleSubject(ORG, "completed", "research");
    expect(subjectMatchesPattern(researchLifecycleSubject, defaultLifecycleWild)).toBe(false);
  });

  test("verdictWildcard — cross-stack verdict traffic is isolated", () => {
    const defaultVerdictWild = verdictWildcard(ORG, "review", "default");
    const researchVerdictSubject = verdictSubject(ORG, "review", "approved", "research");
    expect(subjectMatchesPattern(researchVerdictSubject, defaultVerdictWild)).toBe(false);
  });
});
