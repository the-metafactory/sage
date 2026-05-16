import { describe, expect, test } from "bun:test";

import { DEFAULT_STACK, resolveStack } from "../../src/util/stack.ts";

/**
 * Stack resolver — replaces the segment validation that used to live in
 * sage's local `validateStack` shim. After myelin#159 the canonical
 * regex `STACK_SEGMENT_REGEX` is exported by myelin, and `resolveStack`
 * is the boot-path helper that picks up `cfg.stack ?? "default"` and
 * fails near startup on a malformed `SAGE_STACK` env value.
 */
describe("resolveStack", () => {
  test("defaults to `default` when undefined", () => {
    expect(resolveStack(undefined)).toBe(DEFAULT_STACK);
    expect(DEFAULT_STACK).toBe("default");
  });

  test("accepts canonical stack names", () => {
    expect(resolveStack("default")).toBe("default");
    expect(resolveStack("research")).toBe("research");
    expect(resolveStack("multi-stack-name")).toBe("multi-stack-name");
  });

  test("rejects malformed segments with a specific error", () => {
    // Holly review on PR#31 (sage), major #1 — operator misconfig like
    // SAGE_STACK="Default" or "foo!" used to silently produce a subject
    // that NATS would reject mid-publish. resolveStack fails on the
    // boot path instead, so the operator sees the error immediately.
    expect(() => resolveStack("Default")).toThrow(/must match/);
    expect(() => resolveStack("default!")).toThrow(/must match/);
    expect(() => resolveStack("")).toThrow(/must match/);
    expect(() => resolveStack(">")).toThrow(/must match/);
    expect(() => resolveStack("*")).toThrow(/must match/);
  });
});
