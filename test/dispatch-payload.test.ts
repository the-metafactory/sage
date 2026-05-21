import { describe, test, expect } from "bun:test";
import {
  buildTaskEnvelopeSpec,
  type BuildTaskEnvelopeSpecInput,
} from "../src/tasks/envelope.ts";
import type { DispatchTaskPayload } from "../src/tasks/types.ts";
import type { PrRef } from "../src/forge/types.ts";

/**
 * Adapter so the existing payload-shape tests still read against the
 * Task Envelope Module surface. `buildReviewTaskPayload` used to be
 * exported from `dispatcher.ts`; sage#58 folded it into
 * `buildTaskEnvelopeSpec`. The tests only care about the payload
 * field, so this helper unwraps the spec and drops the placeholder
 * `principal`/`stack` segments needed for Subject derivation.
 */
function buildReviewTaskPayload(input: {
  ref: PrRef;
  post: boolean;
  timeoutSeconds?: number;
  forge?: "github" | "gitlab";
  reviewer?: string;
}): DispatchTaskPayload {
  const args: BuildTaskEnvelopeSpecInput = {
    ref: input.ref,
    principal: "compat",
    stack: "compat",
    post: input.post,
    ...(input.timeoutSeconds !== undefined
      ? { timeoutSeconds: input.timeoutSeconds }
      : {}),
    ...(input.forge !== undefined ? { forge: input.forge } : {}),
    ...(input.reviewer !== undefined ? { reviewer: input.reviewer } : {}),
  };
  return buildTaskEnvelopeSpec(args).payload;
}

/**
 * Issue #8: dispatcher used to always send `payload.post: opts.post`, which
 * meant `--post` omitted on the CLI sent `payload.post=false` and clobbered
 * the daemon's `cfg.postReviews` default via the bridge's
 * `payload.post ?? cfg.postReviews` lookup (??-coalesce treats explicit
 * false as a value, not a nullish miss). Fix: dispatcher OMITS the field
 * when the CLI flag isn't explicitly set.
 *
 * Issue #52: cortex's pipeline reads `payload.repo` (slash-joined
 * "owner/repo") + `payload.pr` (integer) + `payload.reviewer` (string).
 * Pre-#52 the dispatcher only emitted `pr_url`, so cortex rejected
 * every task with `cant_do: payload validation failed`. Tests below
 * pin the new shape — cortex-spec fields PLUS `pr_url` for back-compat.
 *
 * These tests pin the payload shape so neither fix can silently regress.
 */

const URL = "https://github.com/the-metafactory/sage/pull/8";
const REF: PrRef = {
  owner: "the-metafactory",
  repo: "sage",
  number: 8,
};

describe("buildReviewTaskPayload — issue #8", () => {
  test("post=false → omits `post` field entirely (so daemon-default applies)", () => {
    const p = buildReviewTaskPayload({ ref: REF, post: false });
    expect("post" in p).toBe(false);
    // Cortex-spec fields still present even when post is omitted.
    expect(p.pr_url).toBe(URL);
  });

  test("post=true → includes `post: true` (explicit opt-in)", () => {
    const p = buildReviewTaskPayload({ ref: REF, post: true });
    expect(p.post).toBe(true);
    expect(p.pr_url).toBe(URL);
  });

  test("timeoutSeconds=900 → includes `timeout_ms: 900000`", () => {
    const p = buildReviewTaskPayload({ ref: REF, post: true, timeoutSeconds: 900 });
    expect(p.post).toBe(true);
    expect(p.timeout_ms).toBe(900_000);
    expect(p.pr_url).toBe(URL);
  });

  test("no timeoutSeconds → omits `timeout_ms` field", () => {
    const p = buildReviewTaskPayload({ ref: REF, post: true });
    expect("timeout_ms" in p).toBe(false);
  });

  test("timeoutSeconds=0 is treated as omit (falsy guard, matches dispatcher convention)", () => {
    const p = buildReviewTaskPayload({ ref: REF, post: false, timeoutSeconds: 0 });
    expect("timeout_ms" in p).toBe(false);
  });

  test("regression guard: never produce `post: false` in payload", () => {
    // The whole point of this fix — both false and true inputs must not
    // emit `post: false`. False means "absent / let daemon decide".
    for (const post of [false, true] as const) {
      const p = buildReviewTaskPayload({ ref: REF, post });
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
    const payload = buildReviewTaskPayload({ ref: REF, post: false });
    const merged = bridgeMerge(payload.post, true);
    expect(merged).toBe(true);
  });

  test("daemon configured to post; dispatch w/ --post → posts", () => {
    const payload = buildReviewTaskPayload({ ref: REF, post: true });
    const merged = bridgeMerge(payload.post, true);
    expect(merged).toBe(true);
  });

  test("daemon configured NOT to post; dispatch w/o --post → does NOT post (daemon default respected)", () => {
    const payload = buildReviewTaskPayload({ ref: REF, post: false });
    const merged = bridgeMerge(payload.post, false);
    expect(merged).toBe(false);
  });

  test("daemon configured NOT to post; dispatch w/ --post → posts (client overrides)", () => {
    const payload = buildReviewTaskPayload({ ref: REF, post: true });
    const merged = bridgeMerge(payload.post, false);
    expect(merged).toBe(true);
  });

  test("daemon postReviews unset; dispatch w/o --post → final fallback to false (no surprise)", () => {
    const payload = buildReviewTaskPayload({ ref: REF, post: false });
    const merged = bridgeMerge(payload.post, undefined);
    expect(merged).toBe(false);
  });
});
