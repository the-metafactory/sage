/**
 * Lifecycle Interpreter Module — pure async-generator FSM over a
 * lifecycle envelope stream + a verdict envelope stream.
 *
 * Replaces the prior callback-based subscriber loop in
 * `dispatcher.ts` (`consume()` + the surrounding `done` Promise +
 * timer juggling) with a single generator that yields a typed
 * `DispatchEvent` per state transition. The composer
 * (`dispatcher.ts`) renders each event to stderr and treats the
 * `terminated` event as the exit signal — no shared mutable
 * `terminated` flag, no `finish()` closure (sage#58 hybrid A+B+C).
 *
 * Internal FSM states (NOT exposed on the Interface — only
 * `DispatchEvent` is observable):
 *
 *   pre-publish ─► waiting ─► received ─► { completed | failed | timeout }
 *                                  │
 *                                  └─► post-failed-then-waiting ─► …
 *
 * Invariants:
 *   - Yields at most one `silence-warning`; cancelled by any
 *     lifecycle arrival.
 *   - `verdict` and `post-failed` are informational — never terminal.
 *   - `completed` ⇒ lifecycle event + `terminated{0, "completed"}`
 *     then return.
 *   - `failed`    ⇒ lifecycle event + `terminated{1, "failed"}`
 *     then return.
 *   - `waitMs` elapsed without terminal ⇒
 *     `terminated{2, "timeout"}` then return.
 *   - `finally` clause closes both upstream iterables so the
 *     generator is finally-drain safe.
 */

import type { MyelinEnvelope } from "@the-metafactory/myelin";

import type { SubscribedEnvelope } from "./client.ts";

export type LifecycleAction =
  | "received"
  | "started"
  | "progress"
  | "completed"
  | "failed";

export type DispatchEvent =
  | {
      readonly kind: "lifecycle";
      readonly action: LifecycleAction;
      readonly payload: Record<string, unknown>;
      readonly subject: string;
      readonly type: string;
    }
  | {
      readonly kind: "verdict";
      readonly decision: string;
      readonly posted: boolean;
      readonly payload: Record<string, unknown>;
      readonly subject: string;
    }
  | {
      readonly kind: "post-failed";
      readonly error: string;
      readonly recoveryPath?: string;
      readonly payload: Record<string, unknown>;
    }
  | {
      readonly kind: "silence-warning";
      readonly principal: string;
      readonly stack: string;
      readonly silenceMs: number;
    }
  | {
      readonly kind: "terminated";
      readonly exitCode: 0 | 1 | 2;
      readonly reason: "completed" | "failed" | "timeout";
    };

export interface InterpreterInput {
  readonly lifecycle: AsyncIterable<SubscribedEnvelope>;
  readonly verdict: AsyncIterable<SubscribedEnvelope>;
  readonly timeouts: {
    readonly waitMs: number;
    readonly silenceMs: number;
  };
  readonly context: {
    readonly principal: string;
    readonly stack: string;
  };
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Silence threshold before the dispatcher emits a stderr warning
 * suggesting principal/stack/dormant-runtime diagnosis. 5s absorbs
 * normal lifecycle round-trip latency on a healthy local NATS while
 * firing quickly enough to help an operator catch a mistyped
 * `--org` before they walk away assuming the dispatch is just slow
 * (sage#49).
 */
export const SILENCE_WARN_MS = 5_000;

/**
 * Pure-policy: should the silence warning fire given the current
 * dispatcher state? Free function so the policy stays unit-testable
 * without timer mocks. The interpreter calls this directly — one
 * source of truth (sage#65 round-3 Maintainability suggestion).
 */
export function shouldEmitSilenceWarning(state: {
  terminated: boolean;
  receivedSeen: boolean;
}): boolean {
  return !state.terminated && !state.receivedSeen;
}

/**
 * Render the operator-facing silence-warning string. Centralised so
 * wording stays consistent between the dispatcher's `renderEvent`
 * and the unit tests pinning the message shape (sage#49). Also
 * makes it cheap to grep for the warning shape from a log shipper.
 */
export function buildSilenceWarning(opts: {
  org: string;
  stack: string;
  silenceMs?: number;
}): string {
  const seconds = (opts.silenceMs ?? SILENCE_WARN_MS) / 1000;
  return (
    `⚠ no consumer claim after ${seconds}s — verify cortex.yaml operator.id ` +
    `matches --org "${opts.org}" and stack matches "${opts.stack}" ` +
    `(see sage#49). If both align, cortex's review consumer may be DORMANT ` +
    `(see cortex#335 / G-1111).`
  );
}

/**
 * Whitelist for the recovery_path string: absolute path, slug-safe
 * segments, ends with `.md`. CRITICALLY: rejects any segment that
 * is `..` (path-traversal vector). Anything else means the
 * envelope was malformed or hostile; we drop the recovery hint
 * rather than echo arbitrary text into the operator's terminal.
 *
 * Exported so the dispatcher's `renderEvent` can re-validate before
 * interpolation — defense in depth across the Module boundary.
 */
export function isSafeRecoveryPath(p: string): boolean {
  if (!p.startsWith("/") || !p.endsWith(".md")) return false;
  if (!/^[A-Za-z0-9_./-]+$/.test(p)) return false;
  // Reject any `..` segment — the slug regex above lets `..` through
  // as chars; this explicit segment check closes the gap.
  return !p.split("/").includes("..");
}

/**
 * Map a lifecycle envelope's `type` field to the corresponding FSM
 * action. Returns `undefined` for non-lifecycle types (defensive —
 * the subscriber's subject pattern should already exclude them).
 */
function lifecycleActionFromType(type: string): LifecycleAction | undefined {
  switch (type) {
    case "dispatch.task.received":
      return "received";
    case "dispatch.task.started":
      return "started";
    case "dispatch.task.progress":
      return "progress";
    case "dispatch.task.completed":
      return "completed";
    case "dispatch.task.failed":
      return "failed";
    default:
      return undefined;
  }
}

function extractPostFailedEvent(
  envelope: MyelinEnvelope,
): DispatchEvent | undefined {
  const payload = envelope.payload ?? {};
  const errObj = payload.error as { message?: unknown } | string | undefined;
  const errorMsg =
    typeof errObj === "string"
      ? errObj
      : typeof errObj?.message === "string"
        ? errObj.message
        : "<no error message>";
  const recovery = payload.recovery_path;
  const recoveryPath =
    typeof recovery === "string" && isSafeRecoveryPath(recovery)
      ? recovery
      : undefined;
  return {
    kind: "post-failed",
    error: errorMsg,
    ...(recoveryPath !== undefined ? { recoveryPath } : {}),
    payload,
  };
}

function extractVerdictEvent(item: SubscribedEnvelope): DispatchEvent {
  const payload = item.envelope.payload ?? {};
  const decision =
    typeof payload.verdict === "object" && payload.verdict !== null
      ? String((payload.verdict as Record<string, unknown>).decision ?? "")
      : item.envelope.type.replace("code.pr.review.", "");
  const posted = Boolean(payload.posted);
  return {
    kind: "verdict",
    decision,
    posted,
    payload,
    subject: item.subject,
  };
}

/**
 * Race-winner discriminated union. Keeps the generator body
 * readable without scattering `Promise.race` calls inline; the race
 * helper resolves to exactly one of these shapes.
 */
type RaceWinner =
  | { kind: "lifecycle"; result: IteratorResult<SubscribedEnvelope> }
  | { kind: "verdict"; result: IteratorResult<SubscribedEnvelope> }
  | { kind: "silence" }
  | { kind: "timeout" };

type PendingNext = Promise<IteratorResult<SubscribedEnvelope>>;

export async function* interpretDispatch(
  input: InterpreterInput,
): AsyncGenerator<DispatchEvent, void, void> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const lifeIter = input.lifecycle[Symbol.asyncIterator]();
  const verdictIter = input.verdict[Symbol.asyncIterator]();

  let lifePending: PendingNext = lifeIter.next();
  let verdictPending: PendingNext = verdictIter.next();
  // Cache wrapped pending promises alongside the raw ones — `.then()`
  // creates a new promise on each invocation, so re-wrapping the
  // same `lifePending` / `verdictPending` inside `race()` on every
  // loop iteration accumulates unresolved `.then()` handlers
  // against the quiet stream's pending promise (sage#65 round-2
  // Performance suggestion). Recreated only when the underlying
  // iterator advances.
  let lifeWrapped: Promise<RaceWinner> = lifePending.then(
    (result) => ({ kind: "lifecycle" as const, result }),
  );
  let verdictWrapped: Promise<RaceWinner> = verdictPending.then(
    (result) => ({ kind: "verdict" as const, result }),
  );
  let silenceFired = false;

  try {
    while (true) {
      const elapsed = now() - startedAt;
      const waitRemainingMs = Math.max(0, input.timeouts.waitMs - elapsed);
      const silenceRemainingMs = silenceFired
        ? Number.POSITIVE_INFINITY
        : Math.max(0, input.timeouts.silenceMs - elapsed);

      const winner = await race(
        lifeWrapped,
        verdictWrapped,
        silenceRemainingMs,
        waitRemainingMs,
      );

      if (winner.kind === "timeout") {
        yield {
          kind: "terminated",
          exitCode: 2,
          reason: "timeout",
        };
        return;
      }

      if (winner.kind === "silence") {
        // Re-check policy at fire-time. Silence has its own boolean
        // because both branches (lifecycle arrival + initial fire)
        // need to suppress further firings; routing through the
        // exported `shouldEmitSilenceWarning` keeps one
        // predicate definition.
        if (
          shouldEmitSilenceWarning({
            terminated: false,
            receivedSeen: silenceFired,
          })
        ) {
          yield {
            kind: "silence-warning",
            principal: input.context.principal,
            stack: input.context.stack,
            silenceMs: input.timeouts.silenceMs,
          };
        }
        silenceFired = true;
        continue;
      }

      if (winner.kind === "lifecycle") {
        // Any lifecycle envelope cancels the silence timer — set
        // `silenceFired` so the upcoming race doesn't re-arm it.
        silenceFired = true;

        const { result } = winner;
        if (result.done) {
          // Lifecycle stream ended without a terminal envelope —
          // treat as timeout for exit-code purposes. Cortex closing
          // its side mid-dispatch is the practical trigger.
          yield {
            kind: "terminated",
            exitCode: 2,
            reason: "timeout",
          };
          return;
        }

        lifePending = lifeIter.next();
        lifeWrapped = lifePending.then((result) => ({
          kind: "lifecycle" as const,
          result,
        }));

        const item = result.value as SubscribedEnvelope;
        const action = lifecycleActionFromType(item.envelope.type);

        if (item.envelope.type === "dispatch.task.post-failed") {
          const ev = extractPostFailedEvent(item.envelope);
          if (ev) yield ev;
          // post-failed is informational — keep waiting for the
          // terminal lifecycle envelope (`completed` arrives next).
          continue;
        }

        if (!action) continue;

        yield {
          kind: "lifecycle",
          action,
          payload: item.envelope.payload ?? {},
          subject: item.subject,
          type: item.envelope.type,
        };

        if (action === "completed") {
          yield { kind: "terminated", exitCode: 0, reason: "completed" };
          return;
        }
        if (action === "failed") {
          yield { kind: "terminated", exitCode: 1, reason: "failed" };
          return;
        }
        continue;
      }

      if (winner.kind === "verdict") {
        const { result } = winner;
        if (result.done) {
          // Verdict stream ended — non-terminal; keep listening on
          // lifecycle. Re-arm with a never-settling promise so the
          // outer race never re-selects this branch.
          verdictPending = new Promise<IteratorResult<SubscribedEnvelope>>(
            () => {},
          );
          verdictWrapped = verdictPending.then((r) => ({
            kind: "verdict" as const,
            result: r,
          }));
          continue;
        }
        verdictPending = verdictIter.next();
        verdictWrapped = verdictPending.then((r) => ({
          kind: "verdict" as const,
          result: r,
        }));
        yield extractVerdictEvent(result.value);
        continue;
      }
    }
  } finally {
    // Best-effort close upstream iterables. Both streams are
    // expected to be Bus Client `EnvelopeStream`s whose `close()` is
    // idempotent + non-throwing; an iterator without `.return()` is
    // skipped silently.
    try {
      await lifeIter.return?.();
    } catch {
      /* swallow — composer's finally also drains */
    }
    try {
      await verdictIter.return?.();
    } catch {
      /* swallow */
    }
  }
}

async function race(
  lifeWrapped: Promise<RaceWinner>,
  verdictWrapped: Promise<RaceWinner>,
  silenceMs: number,
  waitMs: number,
): Promise<RaceWinner> {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const racers: Array<Promise<RaceWinner>> = [
    lifeWrapped,
    verdictWrapped,
  ];
  if (Number.isFinite(silenceMs)) {
    racers.push(
      new Promise<RaceWinner>((resolve) => {
        const t = setTimeout(() => resolve({ kind: "silence" }), silenceMs);
        timers.push(t);
      }),
    );
  }
  racers.push(
    new Promise<RaceWinner>((resolve) => {
      const t = setTimeout(() => resolve({ kind: "timeout" }), waitMs);
      timers.push(t);
    }),
  );

  try {
    return await Promise.race(racers);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
}
