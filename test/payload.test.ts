import { describe, test, expect } from "bun:test";
import type { Equal, Expect } from "./_type-utils.ts";
import {
  TaskPayloadSchema,
  type ReviewTaskPayload,
  type DispatchTaskPayload,
} from "../src/bus/payload.ts";

/**
 * Issue #10: canonical schema for the code-review task envelope's payload,
 * shared between bridge.ts (receiver) and dispatcher.ts (sender). Tests
 * pin (a) the runtime Zod behavior at both wire directions, and (b) the
 * relationship between the two TypeScript types so a future field add in
 * `TaskPayloadSchema` is mechanically reflected in both.
 */

describe("TaskPayloadSchema (runtime)", () => {
  test("accepts a payload with just pr_url", () => {
    const r = TaskPayloadSchema.safeParse({
      pr_url: "https://github.com/x/y/pull/1",
    });
    expect(r.success).toBe(true);
  });

  test("accepts a payload with the owner+repo+number triple", () => {
    const r = TaskPayloadSchema.safeParse({
      owner: "x",
      repo: "y",
      number: 42,
    });
    expect(r.success).toBe(true);
  });

  test("rejects a payload with neither pr_url nor full triple", () => {
    const r = TaskPayloadSchema.safeParse({ owner: "x" });
    expect(r.success).toBe(false);
  });

  test("rejects a payload with partial triple (owner+repo, no number)", () => {
    const r = TaskPayloadSchema.safeParse({ owner: "x", repo: "y" });
    expect(r.success).toBe(false);
  });

  test("accepts optional post + timeout_ms when present", () => {
    const r = TaskPayloadSchema.safeParse({
      pr_url: "https://github.com/x/y/pull/1",
      post: true,
      timeout_ms: 60_000,
    });
    expect(r.success).toBe(true);
  });

  test("rejects negative or zero timeout_ms", () => {
    for (const bad of [0, -1, -1000]) {
      const r = TaskPayloadSchema.safeParse({
        pr_url: "https://github.com/x/y/pull/1",
        timeout_ms: bad,
      });
      expect(r.success).toBe(false);
    }
  });

  test("rejects non-integer number field", () => {
    const r = TaskPayloadSchema.safeParse({ owner: "x", repo: "y", number: 1.5 });
    expect(r.success).toBe(false);
  });

  test("rejects non-URL pr_url", () => {
    const r = TaskPayloadSchema.safeParse({ pr_url: "not a url" });
    expect(r.success).toBe(false);
  });
});

describe("DispatchTaskPayload (sender narrowing)", () => {
  test("post is constrained to true | undefined (compile-time)", () => {
    // True opt-in: this compiles.
    const a: DispatchTaskPayload = {
      pr_url: "https://github.com/x/y/pull/1",
      post: true,
    };
    // Omission: this compiles too.
    const b: DispatchTaskPayload = { pr_url: "https://github.com/x/y/pull/1" };
    expect(a.post).toBe(true);
    expect(b.post).toBeUndefined();

    // The following should NOT compile (verified manually — TS would
    // reject `post: false`):
    //   const c: DispatchTaskPayload = { pr_url: "...", post: false };
    //
    // We can't `expect(...).toThrow` a compile error, so we encode the
    // intent here as a runtime guard against accidental relaxation:
    type PostFieldType = DispatchTaskPayload["post"];
    type _Check = Expect<Equal<PostFieldType, true | undefined>>;
    // The `_Check` line fails to type-check if `post` widens.
  });

  test("pr_url is REQUIRED on the sender side", () => {
    // Compile-time: required field. Type-system check:
    type PrUrlRequired = "pr_url" extends keyof Required<DispatchTaskPayload> ? true : false;
    type _Check = Expect<Equal<PrUrlRequired, true>>;
    expect(true).toBe(true); // runtime sentinel so the test counts
  });

  test("DispatchTaskPayload at runtime still validates against TaskPayloadSchema", () => {
    // A correctly-shaped DispatchTaskPayload must round-trip through the
    // canonical schema — otherwise the sender and receiver disagree.
    const payload: DispatchTaskPayload = {
      pr_url: "https://github.com/x/y/pull/1",
      post: true,
      timeout_ms: 60_000,
    };
    const r = TaskPayloadSchema.safeParse(payload);
    expect(r.success).toBe(true);
  });
});

describe("Shape parity between sender and receiver", () => {
  test("ReviewTaskPayload (receiver) has all the fields DispatchTaskPayload uses", () => {
    // Compile-time check: every key on the sender type must exist on the
    // receiver type. If a future protocol field is added to
    // DispatchTaskPayload without updating TaskPayloadSchema, this fails.
    type SenderKeys = keyof DispatchTaskPayload;
    type ReceiverKeys = keyof ReviewTaskPayload;
    type Missing = Exclude<SenderKeys, ReceiverKeys>;
    type _Check = Expect<Equal<Missing, never>>;
    expect(true).toBe(true);
  });
});
