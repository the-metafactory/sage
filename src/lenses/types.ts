export type Severity = "blocker" | "important" | "suggestion" | "nit";

export interface Finding {
  /** File path relative to repo root. */
  path: string;
  /** 1-indexed line number in the new revision. Use 0 for file-level findings. */
  line: number;
  severity: Severity;
  title: string;
  rationale: string;
  /** Optional suggested patch (small inline replacement). */
  suggestion?: string;
  /** Lenses that raised this finding before cross-lens deduplication. */
  sourceLenses?: string[];
}

export interface LensReport {
  lens: string;
  summary: string;
  findings: Finding[];
  durationMs: number;
  /**
   * True when the lens failed to execute — runtime throw, substrate
   * unavailable, or model output unparseable as JSON. The accompanying
   * `findings` carry a single synthesized `important` entry describing
   * the failure mode, but the absence of real findings is the load-
   * bearing fact: the verdict must not approve a PR whose lenses didn't
   * actually run.
   *
   * Bus contract — this `LensReport` shape rides NATS via
   * `onLensComplete` → bridge → `dispatch.task.progress` (lens-level)
   * and is embedded in the final `code.pr.review.*` verdict envelope.
   * Downstream consumers fall into two categories:
   *
   *   - **trustworthiness-aware** (cortex dashboard verdict trust scoring,
   *     pilot-loop retry decisions, audit log): SHOULD branch on
   *     `errored` to distinguish "lens ran, found nothing" from "lens
   *     never ran"
   *   - **severity-only** (rendering, merge-gate counters): MAY ignore
   *     the flag — the synthesized `important` finding ensures their
   *     existing severity-based logic still flags merge-block via
   *     `decideVerdict`
   *
   * Optional / omitted on the success path so the on-disk verdict JSON
   * for clean reviews stays byte-identical to pre-#26 output.
   */
  errored?: boolean;
}

/**
 * Construct an errored `LensReport`. Used at both synthesis sites:
 *
 *   - `runLens` (src/lenses/base.ts) — substrate-fallback path; the
 *     lens's substrate.runJson threw or the model output couldn't be
 *     parsed. `source: "output"`.
 *   - `reviewPr` (src/lenses/workflow.ts) — inline-catch path; the
 *     lens implementation bypassed `runLens` and threw directly.
 *     `source: "runtime"`.
 *
 * Sharing the constructor keeps the `errored: true` contract
 * byte-stable across both sites — pre-extraction the two sites
 * carried slightly different summary strings (Holly review of sage#27
 * round 3, finding #2), which made the rendered review body look
 * inconsistent depending on which path failed.
 */
export interface ErroredLensReportInput {
  lens: string;
  rationale: string;
  durationMs: number;
  /**
   * Where the failure surfaced. `runtime` → lens-level throw (the
   * lens implementation itself crashed). `output` → substrate-level
   * fallback (the substrate ran but didn't produce a usable verdict).
   * Only affects the diagnostic finding's `path` and `title` —
   * everything else is identical between the two paths so the verdict
   * gate, renderer, and bus contract all behave the same.
   */
  source: "runtime" | "output";
}

export function buildErroredLensReport(opts: ErroredLensReportInput): LensReport {
  const isRuntime = opts.source === "runtime";
  return {
    lens: opts.lens,
    summary: `Lens "${opts.lens}" did not produce a usable verdict; verdict cannot rely on this lens.`,
    findings: [
      {
        path: isRuntime ? "(lens runtime)" : "(lens output)",
        line: 0,
        severity: "important",
        title: isRuntime
          ? `${opts.lens}: lens runtime error`
          : `${opts.lens}: model deviated from JSON contract`,
        rationale: opts.rationale,
      },
    ],
    durationMs: opts.durationMs,
    errored: true,
  };
}
