import { describe, test, expect } from "bun:test";
import { typeCheck, type Equal } from "./_type-utils.ts";
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

  test("rejects a completely empty payload", () => {
    // Neither pr_url nor any of (owner, repo, number) — the refinement's
    // disjunction must reject this. Without this case, a regression that
    // returned `true` for `{}` would go unnoticed (none of the existing
    // tests exercise the all-fields-absent branch).
    const r = TaskPayloadSchema.safeParse({});
    expect(r.success).toBe(false);
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

  // Per-iteration assertion: a single failure tells us *which* value
  // slipped through, which a bare `expect(r.success).toBe(false)` in a
  // `for` loop would not. Same shape applied to `number` below so a
  // regression dropping `.positive()` from either field is caught.
  test.each([0, -1, -1000])("rejects timeout_ms=%s (non-positive)", (bad) => {
    const r = TaskPayloadSchema.safeParse({
      pr_url: "https://github.com/x/y/pull/1",
      timeout_ms: bad,
    });
    expect(r.success).toBe(false);
  });

  test.each([0, -1, -1000])("rejects number=%s (non-positive)", (bad) => {
    // owner+repo+number satisfies the disjunction refinement, so the
    // rejection here is from `.int().positive()` on the `number` field
    // — not a short-circuit on the disjunction.
    const r = TaskPayloadSchema.safeParse({
      owner: "x",
      repo: "y",
      number: bad,
    });
    expect(r.success).toBe(false);
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
  test("post is constrained to true | undefined", () => {
    // True opt-in: this compiles.
    const a: DispatchTaskPayload = {
      pr_url: "https://github.com/x/y/pull/1",
      post: true,
    };
    // Omission: this compiles too.
    const b: DispatchTaskPayload = { pr_url: "https://github.com/x/y/pull/1" };
    expect(a.post).toBe(true);
    expect(b.post).toBeUndefined();

    // The following would NOT compile (TS rejects `post: false`):
    //   const c: DispatchTaskPayload = { pr_url: "...", post: false };
    //
    // The `typeCheck` call below pins this — if `post` widens to
    // `boolean`, the file fails to type-check. Do not delete it thinking
    // it is redundant with the runtime asserts above.
    type PostFieldType = DispatchTaskPayload["post"];
    typeCheck<Equal<PostFieldType, true | undefined>>();
  });

  test("pr_url is required at the type level", () => {
    // Compile-time only: `typeCheck` lifts the `Equal` assertion into a
    // callable so we don't need an `expect(true).toBe(true)` sentinel.
    type PrUrlRequired = "pr_url" extends keyof Required<DispatchTaskPayload> ? true : false;
    typeCheck<Equal<PrUrlRequired, true>>();
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
  test("every DispatchTaskPayload key exists on ReviewTaskPayload (sender ⊆ receiver)", () => {
    // ONE-DIRECTIONAL check: if a sender-side field is added without a
    // matching schema entry, this fails. The inverse direction (receiver
    // gains a field the sender should ALSO ship) is intentionally NOT
    // checked — adding a sender-side field is a manual decision per the
    // MAINTAINER CHECKLIST in src/bus/payload.ts.
    type SenderKeys = keyof DispatchTaskPayload;
    type ReceiverKeys = keyof ReviewTaskPayload;
    type Missing = Exclude<SenderKeys, ReceiverKeys>;
    typeCheck<Equal<Missing, never>>();
  });
});
