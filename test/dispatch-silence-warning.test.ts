import { describe, test, expect } from "bun:test";
import {
  SILENCE_WARN_MS,
  buildSilenceWarning,
  shouldEmitSilenceWarning,
} from "../src/bus/lifecycle.ts";

/**
 * sage#49: `sage dispatch` against a misaligned cortex (org / stack
 * mismatch, or dormant runtime per cortex#335 / G-1111) hangs silently
 * until the primary `--wait` timeout fires. Adds a 5s silence-warning
 * timer that points the operator at the three most likely causes.
 *
 * These tests pin the pure policy + message shape so the warning
 * cannot regress when the dispatcher's wider control flow changes.
 * The timer wiring itself (and the live NATS round-trip path) stays
 * an integration concern.
 */

describe("SILENCE_WARN_MS", () => {
  test("threshold is 5 seconds (operator-perceivable)", () => {
    // Lower bound: 5s is the smallest interval that comfortably absorbs
    // normal lifecycle round-trip latency on a healthy local NATS while
    // still firing quickly enough to help an operator catch a mistyped
    // --org. Locking this in to make any future tuning an explicit,
    // visible change.
    expect(SILENCE_WARN_MS).toBe(5_000);
  });
});

describe("shouldEmitSilenceWarning (sage#49)", () => {
  test("emits when neither terminated nor any received envelope", () => {
    expect(shouldEmitSilenceWarning({ terminated: false, receivedSeen: false })).toBe(true);
  });

  test("suppresses after the wait timer / lifecycle terminal already fired", () => {
    // `terminated` flips when `finish()` runs — primary timeout or a
    // dispatch.task.{completed,failed} envelope. Firing the silence
    // warning after that would mislead the operator into thinking the
    // dispatch was silent when in fact a verdict already landed.
    expect(shouldEmitSilenceWarning({ terminated: true, receivedSeen: false })).toBe(false);
  });

  test("suppresses when a lifecycle envelope was observed", () => {
    // ANY lifecycle envelope sets receivedSeen — `received`, `started`,
    // `completed`, `failed`. The silence warning is a diagnosis aid for
    // the no-claim case only.
    expect(shouldEmitSilenceWarning({ terminated: false, receivedSeen: true })).toBe(false);
  });

  test("suppresses if both flags set (terminated wins; no double-mute drift)", () => {
    expect(shouldEmitSilenceWarning({ terminated: true, receivedSeen: true })).toBe(false);
  });
});

describe("buildSilenceWarning (sage#49)", () => {
  test("includes the org value the dispatcher published with", () => {
    const msg = buildSilenceWarning({ org: "jc", stack: "default" });
    expect(msg).toContain('--org "jc"');
  });

  test("includes the stack value the dispatcher published with", () => {
    const msg = buildSilenceWarning({ org: "metafactory", stack: "feature-branch" });
    expect(msg).toContain('stack matches "feature-branch"');
  });

  test("points at the cortex.yaml operator.id field name (actionable hint)", () => {
    const msg = buildSilenceWarning({ org: "x", stack: "y" });
    expect(msg).toContain("cortex.yaml operator.id");
  });

  test("references sage#49 (this issue) and cortex#335 (the dormant-runtime root cause)", () => {
    const msg = buildSilenceWarning({ org: "x", stack: "y" });
    expect(msg).toContain("sage#49");
    expect(msg).toContain("cortex#335");
    expect(msg).toContain("G-1111");
  });

  test("seconds value is derived from silenceMs (no hard-coded 5)", () => {
    const msg = buildSilenceWarning({ org: "x", stack: "y", silenceMs: 12_000 });
    expect(msg).toContain("after 12s");
    expect(msg).not.toContain("after 5s");
  });

  test("defaults to SILENCE_WARN_MS when silenceMs omitted", () => {
    const msg = buildSilenceWarning({ org: "x", stack: "y" });
    expect(msg).toContain(`after ${SILENCE_WARN_MS / 1000}s`);
  });

  test("warning begins with the operator-visible ⚠ glyph", () => {
    // The glyph is the grep-anchor for log shippers / dashboards that
    // want to fire an alert specifically on dispatch-silence (not on
    // every dispatcher log line). Pin it so it can't be silently
    // re-themed away.
    expect(buildSilenceWarning({ org: "x", stack: "y" }).startsWith("⚠")).toBe(true);
  });
});
