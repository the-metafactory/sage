/**
 * Lens-run scheduling Module.
 *
 * `workflow.ts` previously held the scheduling job inline: applicability
 * filter, bounded-parallel execution, error synthesis, the
 * `onLensComplete` progress callback, env-driven concurrency parsing.
 * sage#59 extracts the job into one Module exposing `runLenses`. The
 * workflow shrinks to a pure composer: fetch → schedule → decide →
 * render → persist → post.
 *
 * The scheduler's invariants (I1–I7) are documented on the
 * `LensScheduleOptions` interface and pinned with deterministic tests
 * (`test/lens-scheduler.test.ts`).
 */

import type { PriorReviewFinding } from "../forge/types.ts";
import type { Substrate } from "../substrate/types.ts";
import type { ArchitectureDocsContext } from "./architecture-docs.ts";
import type { ApplicabilityContext } from "./applicability.ts";
import type { LensRunInput } from "./base.ts";
import { lensUsesArchitectureDocs, type LensModule } from "./registry.ts";
import { buildErroredLensReport, type LensReport } from "./types.ts";

export interface LensScheduleOptions {
  /**
   * Registry to schedule from. Result preserves this declared order
   * (skipped Lenses absent).
   */
  readonly lenses: readonly LensModule[];

  /** Applicability input. Each Lens's `applies?.(ctx)` is evaluated once. */
  readonly ctx: ApplicabilityContext;

  /** Inputs threaded to every applicable Lens.review(). */
  readonly substrate: Substrate;
  readonly priorFindings: readonly PriorReviewFinding[];
  readonly architectureDocs?: ArchitectureDocsContext;

  /** Per-Lens substrate timeout. Falls back to substrate-specific default. */
  readonly timeoutMs?: number;

  /**
   * undefined → unlimited parallelism (`Promise.all` — byte-stable
   * to the pre-#59 behavior).
   * positive integer → bounded worker pool (FIFO claim).
   * Any other value → synchronous throw before any Lens runs.
   */
  readonly concurrency?: number;

  /**
   * Fires once per applicable Lens in COMPLETION order (stream).
   * Failures inside the callback are logged and swallowed. A Lens
   * that throws synthesizes an errored `LensReport`; the callback
   * STILL fires for the synthesized report.
   */
  readonly onLensComplete?: (report: LensReport) => void | Promise<void>;
}

/**
 * Run every applicable Lens.
 *
 * INVARIANTS:
 *   I1. Returned array preserves REGISTRY ORDER of applicable Lenses
 *       (not completion order). Skipped Lenses are absent.
 *   I2. `onLensComplete` fires exactly once per returned LensReport,
 *       in COMPLETION order.
 *   I3. `Lens.review` throw → errored LensReport via
 *       `buildErroredLensReport({ source: "runtime" })`. The callback
 *       still fires for the synthesized report.
 *   I4. `onLensComplete` callback throws are logged + swallowed.
 *   I5. `concurrency === undefined` preserves the historical
 *       `Promise.all` path (byte-stable timing semantics).
 *   I6. `concurrency` not in `{undefined} ∪ ℤ≥1` → synchronous throw
 *       before any Lens runs.
 *   I7. Scheduler does NOT decide Verdict, render, persist, or post —
 *       it returns LensReports and stops.
 */
export async function runLenses(
  opts: LensScheduleOptions,
): Promise<LensReport[]> {
  // I6: synchronous validation BEFORE any Lens runs.
  if (
    opts.concurrency !== undefined &&
    (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1)
  ) {
    throw new Error(
      `lensConcurrency must be an integer >= 1 (got ${opts.concurrency})`,
    );
  }

  // Filter by applicability — preserves the registry's declared
  // order, which becomes the result-array order (I1).
  const applicable = opts.lenses.filter(
    (lens) => !lens.applies || lens.applies(opts.ctx),
  );

  const timeout: { timeoutMs?: number } =
    opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};

  const lensInputBase: Omit<LensRunInput, "substrate" | "priorFindings"> & {
    substrate: Substrate;
    priorFindings: readonly PriorReviewFinding[];
  } = {
    pr: opts.ctx.pr,
    diff: opts.ctx.diff,
    substrate: opts.substrate,
    priorFindings: opts.priorFindings,
    ...timeout,
  };

  const runOne = async (lens: LensModule): Promise<LensReport> => {
    const startedAt = Date.now();
    let report: LensReport;
    try {
      const usesArchitectureDocs = lensUsesArchitectureDocs(lens, opts.ctx);
      const lensInput = usesArchitectureDocs
        ? {
            ...lensInputBase,
            acceptsArchitectureDocs: true,
            ...(opts.architectureDocs ? { architectureDocs: opts.architectureDocs } : {}),
          }
        : lensInputBase;
      report = await lens.review(lensInput as LensRunInput);
    } catch (err) {
      // I3: Lens that throws → errored LensReport (defense in depth
      // — `runLens` (base.ts) already catches substrate errors, so
      // this branch is reached only by Lens impls that bypass it).
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[scheduler] lens "${lens.name}" threw — synthesizing errored report: ${msg}`,
      );
      report = buildErroredLensReport({
        lens: lens.name,
        rationale: msg,
        durationMs: Date.now() - startedAt,
        source: "runtime",
      });
    }
    // I2 + I4: progress callback fires once per applicable Lens in
    // completion order, including for synthesized errored reports.
    // Callback failures are logged and swallowed — a publish error
    // must not discard a completed LensReport.
    try {
      await opts.onLensComplete?.(report);
    } catch (cbErr) {
      const m = cbErr instanceof Error ? cbErr.message : String(cbErr);
      console.error(
        `[scheduler] onLensComplete (${report.lens}) failed: ${m}`,
      );
    }
    return report;
  };

  // I5: concurrency === undefined preserves the historical
  // Promise.all timing semantics; bounded path goes through
  // `runBounded`.
  if (opts.concurrency === undefined) {
    return Promise.all(applicable.map(runOne));
  }
  return runBounded(applicable, opts.concurrency, runOne);
}

/**
 * Env-driven concurrency resolution. Scheduling concern — lives with
 * the scheduler so the workflow doesn't import "lens concurrency"
 * specifics.
 */
export function readConcurrencyEnv(name: string): number | undefined {
  return parseConcurrencyValue(process.env[name], name);
}

export function parseConcurrencyValue(
  raw: string | undefined,
  source: string,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${source} must be an integer >= 1 (got ${JSON.stringify(raw)})`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `${source} must be an integer >= 1 (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

async function runBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  runOne: (item: T) => Promise<R>,
): Promise<R[]> {
  // Caller-level invariant (I6) already validated `concurrency` by
  // the time we reach here, but defense in depth in case a future
  // entry point bypasses `runLenses`.
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `lensConcurrency must be an integer >= 1 (got ${concurrency})`,
    );
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await runOne(items[index]!);
      }
    }),
  );

  return results;
}
