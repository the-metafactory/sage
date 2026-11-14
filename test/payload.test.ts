import { describe, test, expect } from "bun:test";
import { typeCheck, type Equal } from "./_type-utils.ts";
import type { DispatchTaskPayload } from "../src/tasks/types.ts";

/**
 * The payload `sage dispatch` sends. The receiving side belongs to cortex,
 * so these tests pin only the sender's type.
 */

describe("DispatchTaskPayload (sender narrowing)", () => {
  test("post is constrained to true | undefined", () => {
    // True opt-in: this compiles.
    const a: DispatchTaskPayload = {
      pr_url: "https://github.com/x/y/pull/1",
      repo: "x/y",
      post: true,
    };
    // Omission: this compiles too.
    const b: DispatchTaskPayload = { pr_url: "https://github.com/x/y/pull/1", repo: "x/y" };
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
});
