import { describe, expect, test } from "bun:test";
import {
  buildRefUrl,
  buildTaskEnvelopeSpec,
  deriveLifecycleSubject,
  deriveVerdictSubject,
  matchesPublishedEnvelope,
} from "../src/tasks/envelope.ts";

/**
 * sage#58: Task Envelope Module is pure — no I/O, no clock, no env
 * reads. These tests pin the structural invariants:
 *   - payload.post is `true | omitted`, never `false` (sage#8)
 *   - payload.forge omitted when "github" (sage#43 byte-stable)
 *   - reviewer defaults to "capability-dispatch" (sage#52)
 *   - cortex#237 §4.1 fields (repo + pr + reviewer) + legacy pr_url
 *   - Subject + envelope type pre-derived from principal + stack
 */

const ghRef = {
  owner: "the-metafactory",
  repo: "sage",
  number: 61,
  kind: "github" as const,
};

const glRef = {
  owner: "metafactory/team",
  repo: "sage",
  number: 7,
  kind: "gitlab" as const,
  host: "gitlab.example.com",
};

describe("buildTaskEnvelopeSpec", () => {
  test("payload.post = true when post: true", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: true,
    });
    expect(spec.payload.post).toBe(true);
  });

  test("payload.post omitted (sage#8) when post: false", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: false,
    });
    expect("post" in spec.payload).toBe(false);
  });

  test("payload.forge omitted (sage#43 byte-stable) when github", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: false,
    });
    expect("forge" in spec.payload).toBe(false);
  });

  test("payload.forge set when gitlab", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: glRef,
      principal: "jc",
      stack: "default",
      post: false,
    });
    expect(spec.payload.forge).toBe("gitlab");
  });

  test("payload.reviewer defaults to capability-dispatch", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: false,
    });
    expect(spec.payload.reviewer).toBe("capability-dispatch");
  });

  test("payload.reviewer overrides default when supplied", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: false,
      reviewer: "fern",
    });
    expect(spec.payload.reviewer).toBe("fern");
  });

  test("cortex#237 §4.1 fields populated (repo + pr)", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: false,
    });
    expect(spec.payload.repo).toBe("the-metafactory/sage");
    expect(spec.payload.pr).toBe(61);
  });

  test("legacy pr_url populated for back-compat", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: false,
    });
    expect(spec.payload.pr_url).toBe(
      "https://github.com/the-metafactory/sage/pull/61",
    );
  });

  test("timeout_ms = timeoutSeconds × 1000 when provided", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: false,
      timeoutSeconds: 600,
    });
    expect(spec.payload.timeout_ms).toBe(600_000);
  });

  test("derives Subject + type for the task capability", () => {
    const spec = buildTaskEnvelopeSpec({
      ref: ghRef,
      principal: "jc",
      stack: "default",
      post: false,
    });
    expect(spec.subject).toContain("jc");
    expect(spec.subject).toContain("code-review.typescript");
    expect(spec.type).toBe("tasks.code-review.typescript");
    expect(spec.capability).toBe("code-review.typescript");
  });
});

describe("buildRefUrl", () => {
  test("github form", () => {
    expect(buildRefUrl(ghRef)).toBe(
      "https://github.com/the-metafactory/sage/pull/61",
    );
  });
  test("gitlab form picks up host", () => {
    expect(buildRefUrl(glRef)).toBe(
      "https://gitlab.example.com/metafactory/team/sage/-/merge_requests/7",
    );
  });
  test("gitlab default host gitlab.com when host omitted", () => {
    expect(
      buildRefUrl({ ...glRef, host: undefined }),
    ).toBe(
      "https://gitlab.com/metafactory/team/sage/-/merge_requests/7",
    );
  });
});

describe("deriveLifecycleSubject / deriveVerdictSubject", () => {
  test("lifecycle is wildcard form", () => {
    const subj = deriveLifecycleSubject("jc", "default");
    expect(subj).toContain("dispatch.task");
    expect(subj).toContain("jc");
  });
  test("verdict is wildcard form", () => {
    const subj = deriveVerdictSubject("jc", "default");
    expect(subj).toContain("code.pr.review");
    expect(subj).toContain("jc");
  });
});

describe("matchesPublishedEnvelope", () => {
  test("returns true on correlation_id match", () => {
    expect(matchesPublishedEnvelope({ correlation_id: "abc" }, "abc")).toBe(true);
  });
  test("returns false on mismatch", () => {
    expect(matchesPublishedEnvelope({ correlation_id: "abc" }, "xyz")).toBe(false);
  });
  test("returns false when correlation_id absent", () => {
    expect(matchesPublishedEnvelope({}, "abc")).toBe(false);
  });
});
