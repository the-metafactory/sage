import { describe, test, expect } from "bun:test";
import { matchesPublishedEnvelope } from "../src/tasks/envelope.ts";

/**
 * sage#53: dispatch correlation_id filter mismatch with cortex#237 spec.
 *
 * Pre-#53 the dispatcher generated a self-UUID `correlationId`, set it
 * as the published envelope's `correlation_id` field, and filtered
 * lifecycle envelopes by `envelope.correlation_id === self-UUID`.
 *
 * Cortex follows the cortex#237 spec: when it emits a lifecycle /
 * verdict envelope in response to an inbound request, it sets the
 * outbound `correlation_id` to the INBOUND envelope's `id` (NOT the
 * inbound `correlation_id`). So the envelopes cortex emits carry
 * `correlation_id === inboundEnvelope.id`, never matching sage's
 * self-UUID filter. Every dispatch timed out at `--wait` even when
 * cortex completed the work within milliseconds.
 *
 * The fix lets the dispatcher track the PUBLISHED envelope's `id` (the
 * value cortex echoes) instead of a self-generated correlation_id.
 * Tests below pin the filter rule so the regression can't recur.
 */

describe("matchesPublishedEnvelope (sage#53)", () => {
  test("matches when inbound envelope's correlation_id equals published envelope.id", () => {
    // The cortex#237 happy path: cortex stamps the inbound envelope's
    // `id` as `correlation_id` on every lifecycle / verdict envelope it
    // emits. Dispatcher matches on that field.
    const publishedEnvelopeId = "682dc356-0c56-46ff-906e-eb386e2fa26e";
    const inbound = {
      id: "fe8a3eb7-0113-4007-9a58-843e02c9fb05",
      type: "dispatch.task.failed",
      correlation_id: "682dc356-0c56-46ff-906e-eb386e2fa26e",
    };
    expect(matchesPublishedEnvelope(inbound, publishedEnvelopeId)).toBe(true);
  });

  test("does NOT match when inbound correlation_id is a different request", () => {
    const publishedEnvelopeId = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
    const inbound = {
      id: "bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb",
      type: "dispatch.task.completed",
      correlation_id: "cccccccc-2222-2222-2222-cccccccccccc",
    };
    expect(matchesPublishedEnvelope(inbound, publishedEnvelopeId)).toBe(false);
  });

  test("does NOT match when correlation_id is missing from inbound envelope", () => {
    // Belt-and-braces: an inbound envelope lacking `correlation_id`
    // can't possibly be a reply to a specific request. Filter must
    // reject.
    const publishedEnvelopeId = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
    const inbound: { correlation_id?: string } = {};
    expect(matchesPublishedEnvelope(inbound, publishedEnvelopeId)).toBe(false);
  });

  test("regression guard: must NOT compare to inbound envelope.id directly", () => {
    // Pre-#53 some implementations confused this — matched on
    // `envelope.id` rather than `envelope.correlation_id`. Catches
    // a future refactor that flips them back.
    const publishedEnvelopeId = "682dc356-…";
    const inbound = {
      // envelope.id is a NEW UUID for each emitted envelope; matching
      // on it would never connect to the right request.
      id: "fe8a3eb7-…",
      type: "dispatch.task.failed",
      correlation_id: "682dc356-…",
    };
    expect(matchesPublishedEnvelope(inbound, publishedEnvelopeId)).toBe(true);

    // Conversely: an inbound whose `id` happens to equal the published
    // id (impossible in practice — UUIDs are unique) but whose
    // `correlation_id` is different MUST NOT match.
    const sameIdSpurious = {
      id: "682dc356-…",
      type: "dispatch.task.failed",
      correlation_id: "something-else",
    };
    expect(matchesPublishedEnvelope(sameIdSpurious, publishedEnvelopeId)).toBe(false);
  });
});
