import { describe, test, expect } from "bun:test";
import {
  buildEnvelope,
  deriveSubject,
  encodeDidSegment,
  safeValidateEnvelope,
} from "../src/bus/envelope.ts";
import type { DispatchTaskPayload } from "../src/bus/dispatcher.ts";

/**
 * Issue #11: buildEnvelope is generic over the payload type so callers with
 * a precise interface (no index signature) don't have to launder through
 * `as unknown as Record<string, unknown>`. The constraint is `object`, not
 * `Record<string, unknown>`, so closed interfaces are assignable. The Zod
 * parse at the end of buildEnvelope still validates the runtime shape.
 */

describe("buildEnvelope generic", () => {
  test("accepts a precise interface without an index signature (no cast needed)", () => {
    // Importing the real `DispatchTaskPayload` (closed interface, no index
    // signature) means this test moves in lockstep with the production
    // type — if `DispatchTaskPayload` ever gains a field, this call site
    // is the canary, not a stale parallel definition.
    //
    // Pre-fix this call would fail to type-check because
    // `DispatchTaskPayload` is not assignable to `Record<string, unknown>`.
    // With the generic constraint relaxed to `object`, the call compiles
    // cleanly while the Zod parse downstream still validates the runtime
    // shape.
    const payload: DispatchTaskPayload = {
      pr_url: "https://github.com/x/y/pull/1",
      post: true,
    };
    const env = buildEnvelope<DispatchTaskPayload>({
      source: "metafactory.sage.local",
      type: "tasks.code-review.typescript",
      payload,
    });
    expect(env.payload).toEqual({ pr_url: "https://github.com/x/y/pull/1", post: true });
  });

  test("type parameter defaults to Record<string, unknown> for untyped callers", () => {
    const env = buildEnvelope({
      source: "metafactory.sage.local",
      type: "tasks.code-review.typescript",
      payload: { anything: 42, nested: { goes: "here" } },
    });
    expect(env.payload).toEqual({ anything: 42, nested: { goes: "here" } });
  });

  test("Zod runtime parse rejects a payload that isn't a string-keyed record", () => {
    // The generic relaxes the compile-time constraint to `object`, which
    // includes arrays. Runtime Zod still enforces `payload: z.record(...)`,
    // so an array passed through the cast fails fast at parse time.
    expect(() =>
      buildEnvelope({
        source: "metafactory.sage.local",
        type: "tasks.code-review.typescript",
        payload: ["not", "a", "record"] as unknown as object,
      }),
    ).toThrow();
  });
});

describe("buildEnvelope", () => {
  test("populates required fields with defaults", () => {
    const env = buildEnvelope({
      source: "metafactory.sage.local",
      type: "tasks.code-review.typescript",
      payload: { pr_url: "https://github.com/x/y/pull/1" },
    });
    expect(env.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(env.source).toBe("metafactory.sage.local");
    expect(env.type).toBe("tasks.code-review.typescript");
    expect(env.sovereignty.classification).toBe("local");
    expect(env.sovereignty.data_residency).toBe(process.env.SAGE_DATA_RESIDENCY ?? "CH");
    expect(env.sovereignty.max_hop).toBe(0);
    expect(typeof env.timestamp).toBe("string");
  });

  test("preserves correlation_id when supplied", () => {
    const cid = "550e8400-e29b-41d4-a716-446655440000";
    const env = buildEnvelope({
      source: "metafactory.sage.local",
      type: "code.pr.review.commented",
      correlationId: cid,
      payload: {},
    });
    expect(env.correlation_id).toBe(cid);
  });

  test("rejects malformed source via Zod parse", () => {
    expect(() =>
      buildEnvelope({
        source: "BAD",
        type: "tasks.code-review.typescript",
        payload: {},
      }),
    ).toThrow();
  });
});

describe("deriveSubject", () => {
  test("local classification → local.{org}.{type}", () => {
    const env = buildEnvelope({
      source: "metafactory.sage.local",
      type: "code.pr.review.approved",
      payload: {},
    });
    expect(deriveSubject(env)).toBe("local.metafactory.code.pr.review.approved");
  });

  test("public classification omits org segment", () => {
    const env = buildEnvelope({
      source: "metafactory.sage.local",
      type: "registry.package.published",
      sovereignty: { classification: "public" },
      payload: {},
    });
    expect(deriveSubject(env)).toBe("public.registry.package.published");
  });

  test("federated classification keeps org", () => {
    const env = buildEnvelope({
      source: "acme.bot.prod",
      type: "code.pr.review",
      sovereignty: { classification: "federated" },
      payload: {},
    });
    expect(deriveSubject(env)).toBe("federated.acme.code.pr.review");
  });
});

describe("encodeDidSegment", () => {
  test("did:mf:sage → @did-mf-sage", () => {
    expect(encodeDidSegment("did:mf:sage")).toBe("@did-mf-sage");
  });

  test("dot in method-specific-id → double hyphen", () => {
    // From myelin/specs/namespace.md: `did:mf:hub.metafactory` → `@did-mf-hub--metafactory`
    expect(encodeDidSegment("did:mf:hub.metafactory")).toBe("@did-mf-hub--metafactory");
  });

  test("hyphen preserved", () => {
    expect(encodeDidSegment("did:mf:hub-metafactory")).toBe("@did-mf-hub-metafactory");
  });

  test("hub.metafactory and hub-metafactory encode distinctly", () => {
    expect(encodeDidSegment("did:mf:hub.metafactory")).not.toBe(
      encodeDidSegment("did:mf:hub-metafactory"),
    );
  });

  test("rejects malformed DID", () => {
    expect(() => encodeDidSegment("not-a-did")).toThrow();
  });
});

describe("safeValidateEnvelope", () => {
  test("accepts a well-formed envelope", () => {
    const env = buildEnvelope({
      source: "metafactory.sage.local",
      type: "tasks.code-review.typescript",
      payload: { pr_url: "https://x.test/x/y/pull/1" },
    });
    const result = safeValidateEnvelope(env);
    expect(result.success).toBe(true);
  });

  test("rejects missing sovereignty block", () => {
    const broken = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      source: "metafactory.sage.local",
      type: "tasks.code-review.typescript",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    const result = safeValidateEnvelope(broken);
    expect(result.success).toBe(false);
  });

  test("rejects extra unknown fields (strict)", () => {
    const env = buildEnvelope({
      source: "metafactory.sage.local",
      type: "tasks.code-review.typescript",
      payload: {},
    });
    const result = safeValidateEnvelope({ ...env, evilField: "bad" });
    expect(result.success).toBe(false);
  });
});
