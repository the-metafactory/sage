import { describe, expect, test } from "bun:test";
import {
  interpretDispatch,
  type DispatchEvent,
} from "../src/bus/lifecycle.ts";
import type { SubscribedEnvelope } from "../src/bus/client.ts";

/**
 * sage#58 Lifecycle Interpreter Module — async-generator FSM.
 *
 * Feed `async function* () { yield fakeEnvelope; }` plus an
 * injectable clock; assert the DispatchEvent sequence. No NATS, no
 * real timers — the FSM is unit-testable in isolation.
 */

function ev(
  type: string,
  payload: Record<string, unknown> = {},
  correlation_id = "abc",
): SubscribedEnvelope {
  return {
    envelope: {
      id: "envid-" + Math.random().toString(36).slice(2),
      source: "test",
      type,
      time: new Date().toISOString(),
      correlation_id,
      payload,
    } as unknown as SubscribedEnvelope["envelope"],
    subject: `local.jc.default.${type}`,
  };
}

async function* fromArray(
  arr: SubscribedEnvelope[],
): AsyncIterable<SubscribedEnvelope> {
  for (const item of arr) yield item;
}

/**
 * An iterable that never resolves its next() — used to model a
 * live NATS subscription that has no envelopes yet but is still
 * open. Plain `fromArray([])` ends immediately, which the
 * interpreter treats as a stream-closed-mid-dispatch timeout —
 * not what most "no activity" tests want to assert.
 */
function pendingForever(): AsyncIterable<SubscribedEnvelope> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SubscribedEnvelope> {
      return {
        next: () => new Promise<IteratorResult<SubscribedEnvelope>>(() => {}),
      };
    },
  };
}

/**
 * Deferred queue iterable — caller pushes envelopes via `push()`;
 * the iterator yields them in order. Lets tests control envelope
 * timing without race-y `fromArray` ordering.
 */
function deferredStream() {
  const queue: SubscribedEnvelope[] = [];
  const waiters: Array<(v: IteratorResult<SubscribedEnvelope>) => void> = [];
  let closed = false;
  const iterable: AsyncIterable<SubscribedEnvelope> = {
    [Symbol.asyncIterator](): AsyncIterator<SubscribedEnvelope> {
      return {
        next() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<SubscribedEnvelope>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };
  return {
    iterable,
    push(item: SubscribedEnvelope) {
      const w = waiters.shift();
      if (w) w({ value: item, done: false });
      else queue.push(item);
    },
    close() {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined, done: true });
      }
    },
  };
}

async function collect(
  gen: AsyncGenerator<DispatchEvent, void, void>,
): Promise<DispatchEvent[]> {
  const out: DispatchEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/**
 * A REAL async generator that never yields and never completes — its
 * `.next()` stays pending forever. Unlike `pendingForever()` (a plain
 * object with no `.return()`), this has a generator `.return()` that the
 * runtime serialises BEHIND the outstanding `.next()`. That is exactly the
 * production shape (`filterByCorrelation` wrapping a live-but-silent NATS
 * subscription) that deadlocked `interpretDispatch`'s finally (sage#77).
 */
async function* quietGenerator(): AsyncGenerator<SubscribedEnvelope> {
  // Never yields and never returns — `.next()` stays pending forever.
  // (No unreachable `yield` needed: a generator may yield zero times, so the
  // declared `SubscribedEnvelope` yield type is satisfied vacuously.)
  await new Promise<never>(() => {
    /* never resolves — models a live subscription with no traffic */
  });
}

/** Reject if `p` doesn't settle within `ms` — turns a hang into a failure. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms (hang)`)), ms),
    ),
  ]);
}

describe("interpretDispatch — terminal events", () => {
  test("completed lifecycle yields {lifecycle:completed} + {terminated,0}", async () => {
    const gen = interpretDispatch({
      lifecycle: fromArray([ev("dispatch.task.completed")]),
      verdict: fromArray([]),
      timeouts: { waitMs: 60_000, silenceMs: 30_000 },
      context: { principal: "jc", stack: "default" },
    });
    const events = await collect(gen);

    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("lifecycle");
    expect(events[1]).toEqual({
      kind: "terminated",
      exitCode: 0,
      reason: "completed",
    });
  });

  test("sage#77 — completed via lifecycle terminates even when the verdict stream is a live async generator (no finally deadlock)", async () => {
    // Repro for the dispatch hang: completion arrives on the lifecycle
    // stream while the verdict stream is a real async generator with an
    // outstanding pending `.next()`. The old finally `await
    // verdictIter.return?.()` serialised behind that pending `.next()` and
    // never resolved → the whole dispatch wedged. `withTimeout` turns a
    // recurrence into a test failure instead of a hung suite.
    const gen = interpretDispatch({
      lifecycle: fromArray([ev("dispatch.task.completed")]),
      verdict: quietGenerator(),
      timeouts: { waitMs: 60_000, silenceMs: 30_000 },
      context: { principal: "jc", stack: "default" },
    });
    const events = await withTimeout(collect(gen), 2_000);
    expect(events[events.length - 1]).toEqual({
      kind: "terminated",
      exitCode: 0,
      reason: "completed",
    });
  });

  test("failed lifecycle yields {lifecycle:failed} + {terminated,1}", async () => {
    const gen = interpretDispatch({
      lifecycle: fromArray([ev("dispatch.task.failed")]),
      verdict: fromArray([]),
      timeouts: { waitMs: 60_000, silenceMs: 30_000 },
      context: { principal: "jc", stack: "default" },
    });
    const events = await collect(gen);

    expect(events[events.length - 1]).toEqual({
      kind: "terminated",
      exitCode: 1,
      reason: "failed",
    });
  });

  test("timeout: no lifecycle envelope within waitMs → {terminated,2,timeout}", async () => {
    const gen = interpretDispatch({
      lifecycle: fromArray([]),
      verdict: fromArray([]),
      timeouts: { waitMs: 10, silenceMs: 1_000_000 },
      context: { principal: "jc", stack: "default" },
    });
    const events = await collect(gen);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "terminated",
      exitCode: 2,
      reason: "timeout",
    });
  });
});

describe("interpretDispatch — informational events", () => {
  test("verdict envelope is non-terminal; surfaces before completion", async () => {
    const life = deferredStream();
    const ver = deferredStream();
    const gen = interpretDispatch({
      lifecycle: life.iterable,
      verdict: ver.iterable,
      timeouts: { waitMs: 60_000, silenceMs: 30_000 },
      context: { principal: "jc", stack: "default" },
    });

    // Iterate manually so we can step between pushes — guarantees the
    // verdict is consumed before completed lands. Mirrors the
    // production shape: subscribe → publish → verdict arrives → then
    // completed arrives.
    const events: DispatchEvent[] = [];
    ver.push(
      ev("code.pr.review.approved", {
        verdict: { decision: "approved" },
        posted: true,
      }),
    );
    const first = await gen.next();
    expect(first.done).toBe(false);
    events.push(first.value as DispatchEvent);

    life.push(ev("dispatch.task.completed"));
    for await (const e of gen) events.push(e);

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("verdict");
    expect(kinds).toContain("terminated");
    expect(events[events.length - 1]!.kind).toBe("terminated");
  });

  test("post-failed is non-terminal — completed still arrives after", async () => {
    const gen = interpretDispatch({
      lifecycle: fromArray([
        ev("dispatch.task.post-failed", {
          error: { message: "gh exit 1" },
          recovery_path: "/Users/x/.config/sage/reviews/a-b-1.md",
        }),
        ev("dispatch.task.completed"),
      ]),
      verdict: fromArray([]),
      timeouts: { waitMs: 60_000, silenceMs: 30_000 },
      context: { principal: "jc", stack: "default" },
    });
    const events = await collect(gen);

    expect(events[0]).toMatchObject({
      kind: "post-failed",
      error: "gh exit 1",
      recoveryPath: "/Users/x/.config/sage/reviews/a-b-1.md",
    });
    expect(events[events.length - 1]).toMatchObject({
      kind: "terminated",
      exitCode: 0,
      reason: "completed",
    });
  });

  test("post-failed drops recovery_path when path is unsafe (path traversal)", async () => {
    const gen = interpretDispatch({
      lifecycle: fromArray([
        ev("dispatch.task.post-failed", {
          error: "boom",
          recovery_path: "/etc/../etc/passwd.md",
        }),
        ev("dispatch.task.completed"),
      ]),
      verdict: fromArray([]),
      timeouts: { waitMs: 60_000, silenceMs: 30_000 },
      context: { principal: "jc", stack: "default" },
    });
    const events = await collect(gen);

    const pf = events.find((e) => e.kind === "post-failed");
    expect(pf).toBeDefined();
    expect((pf as { recoveryPath?: string }).recoveryPath).toBeUndefined();
  });
});

describe("interpretDispatch — silence warning", () => {
  test("yields silence-warning at most once when no lifecycle envelope arrives", async () => {
    // Use pendingForever so the iterators don't end immediately —
    // that mimics a live NATS subscription with no traffic.
    const gen = interpretDispatch({
      lifecycle: pendingForever(),
      verdict: pendingForever(),
      // silence fires at 5ms, then wait timer at 50ms → expect 2 events
      timeouts: { waitMs: 50, silenceMs: 5 },
      context: { principal: "jc", stack: "default" },
    });
    const events = await collect(gen);

    const silence = events.filter((e) => e.kind === "silence-warning");
    expect(silence).toHaveLength(1);
    expect(silence[0]).toMatchObject({
      kind: "silence-warning",
      principal: "jc",
      stack: "default",
    });
  });

  test("silence-warning cancelled by an arriving lifecycle envelope", async () => {
    // Lifecycle envelope arrives before silenceMs → no silence-warning.
    const gen = interpretDispatch({
      lifecycle: fromArray([ev("dispatch.task.completed")]),
      verdict: pendingForever(),
      timeouts: { waitMs: 1_000, silenceMs: 500 },
      context: { principal: "jc", stack: "default" },
    });
    const events = await collect(gen);
    expect(events.some((e) => e.kind === "silence-warning")).toBe(false);
  });
});
