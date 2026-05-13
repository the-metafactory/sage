import { describe, test, expect } from "bun:test";
import { buildReviewTaskPayload } from "../src/bus/dispatcher.ts";

/**
 * Issue #8: dispatcher used to always send `payload.post: opts.post`, which
 * meant `--post` omitted on the CLI sent `payload.post=false` and clobbered
 * the daemon's `cfg.postReviews` default via the bridge's
 * `payload.post ?? cfg.postReviews` lookup (??-coalesce treats explicit
 * false as a value, not a nullish miss). Fix: dispatcher OMITS the field
 * when the CLI flag isn't explicitly set.
 *
 * These tests pin the payload shape so the fix can't silently regress.
 */

const URL = "https://github.com/the-metafactory/sage/pull/8";

describe("buildReviewTaskPayload — issue #8", () => {
  test("post=false → omits `post` field entirely (so daemon-default applies)", () => {
    const p = buildReviewTaskPayload({ prUrl: URL, post: false });
    expect(p).toEqual({ pr_url: URL });
    expect("post" in p).toBe(false);
  });

  test("post=true → includes `post: true` (explicit opt-in)", () => {
    const p = buildReviewTaskPayload({ prUrl: URL, post: true });
    expect(p).toEqual({ pr_url: URL, post: true });
    expect(p.post).toBe(true);
  });

  test("timeoutSeconds=900 → includes `timeout_ms: 900000`", () => {
    const p = buildReviewTaskPayload({ prUrl: URL, post: true, timeoutSeconds: 900 });
    expect(p).toEqual({ pr_url: URL, post: true, timeout_ms: 900_000 });
  });

  test("no timeoutSeconds → omits `timeout_ms` field", () => {
    const p = buildReviewTaskPayload({ prUrl: URL, post: true });
    expect("timeout_ms" in p).toBe(false);
  });

  test("timeoutSeconds=0 is treated as omit (falsy guard, matches dispatcher convention)", () => {
    const p = buildReviewTaskPayload({ prUrl: URL, post: false, timeoutSeconds: 0 });
    expect("timeout_ms" in p).toBe(false);
  });

  test("post=false + no timeout → minimal payload, just pr_url", () => {
    const p = buildReviewTaskPayload({ prUrl: URL, post: false });
    expect(Object.keys(p)).toEqual(["pr_url"]);
  });

  test("regression guard: never produce `post: false` in payload", () => {
    // The whole point of this fix — both false and true inputs must not
    // emit `post: false`. False means "absent / let daemon decide".
    for (const post of [false, true] as const) {
      const p = buildReviewTaskPayload({ prUrl: URL, post });
      expect(p.post).not.toBe(false);
    }
  });
});

/**
 * Simulated bridge merge to demonstrate the user-visible behavior change.
 *
 * Pre-fix the bridge saw `payload.post=false` and computed
 *   false ?? cfg.postReviews ?? false  →  false
 * even with cfg.postReviews=true. After the fix, payload.post is missing,
 * so the lookup falls through:
 *   undefined ?? cfg.postReviews ?? false  →  cfg.postReviews
 */
describe("integration with bridge's nullish-coalesce semantics", () => {
  const bridgeMerge = (
    payloadPost: boolean | undefined,
    cfgPostReviews: boolean | undefined,
  ): boolean => payloadPost ?? cfgPostReviews ?? false;

  test("daemon configured to post; dispatch w/o --post → posts (the fix)", () => {
    const payload = buildReviewTaskPayload({ prUrl: URL, post: false });
    const merged = bridgeMerge(payload.post, true);
    expect(merged).toBe(true);
  });

  test("daemon configured to post; dispatch w/ --post → posts", () => {
    const payload = buildReviewTaskPayload({ prUrl: URL, post: true });
    const merged = bridgeMerge(payload.post, true);
    expect(merged).toBe(true);
  });

  test("daemon configured NOT to post; dispatch w/o --post → does NOT post (daemon default respected)", () => {
    const payload = buildReviewTaskPayload({ prUrl: URL, post: false });
    const merged = bridgeMerge(payload.post as boolean | undefined, false);
    expect(merged).toBe(false);
  });

  test("daemon configured NOT to post; dispatch w/ --post → posts (client overrides)", () => {
    const payload = buildReviewTaskPayload({ prUrl: URL, post: true });
    const merged = bridgeMerge(payload.post as boolean | undefined, false);
    expect(merged).toBe(true);
  });

  test("daemon postReviews unset; dispatch w/o --post → final fallback to false (no surprise)", () => {
    const payload = buildReviewTaskPayload({ prUrl: URL, post: false });
    const merged = bridgeMerge(payload.post as boolean | undefined, undefined);
    expect(merged).toBe(false);
  });
});
