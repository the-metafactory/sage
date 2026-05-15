import { describe, expect, test } from "bun:test";

import {
  createEnvelope,
  deriveNatsSubject,
  encodeDidSegment,
  validateEnvelope,
} from "@the-metafactory/myelin";

import { buildSovereignty } from "../src/identity.ts";

/**
 * Wiring tests — sage's outbound envelope construction goes through
 * `createEnvelope` + `buildSovereignty`. The previous hand-rolled
 * `buildEnvelope` Zod schema lived in `src/bus/envelope.ts`; that file
 * was deleted when sage adopted `@the-metafactory/myelin` v0.2 — myelin
 * now owns the contract. These tests assert the sage-side wiring still
 * produces schema-valid envelopes with sage's defaults.
 */
describe("envelope wiring (sage + myelin)", () => {
  test("createEnvelope + buildSovereignty produces a valid envelope", () => {
    const env = createEnvelope({
      source: "metafactory.sage.local",
      type: "tasks.code-review.typescript",
      sovereignty: buildSovereignty(),
      payload: { pr_url: "https://github.com/the-metafactory/sage/pull/1" },
    });
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.sovereignty.classification).toBe("local");
    expect(validateEnvelope(env).valid).toBe(true);
  });

  test("deriveNatsSubject prepends classification + org segment", () => {
    const env = createEnvelope({
      source: "metafactory.sage.local",
      type: "tasks.code-review.typescript",
      sovereignty: buildSovereignty(),
      payload: {},
    });
    expect(deriveNatsSubject(env)).toBe(
      "local.metafactory.tasks.code-review.typescript",
    );
  });

  test("encodeDidSegment encodes DID per namespace.md", () => {
    expect(encodeDidSegment("did:mf:sage")).toBe("@did-mf-sage");
    expect(encodeDidSegment("did:mf:hub.metafactory")).toBe(
      "@did-mf-hub--metafactory",
    );
  });
});
