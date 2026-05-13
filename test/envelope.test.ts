import { describe, test, expect } from "bun:test";
import {
  buildEnvelope,
  deriveSubject,
  encodeDidSegment,
  safeValidateEnvelope,
} from "../src/bus/envelope.ts";

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
