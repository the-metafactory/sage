/**
 * Substrate JSON extraction Module — entry points.
 *
 * `extractFromRun` runs a `JsonPipeline` against a captured
 * `SubstrateRunResult`. Pure (in-process), never spawns. Returns a
 * discriminated union so callers can decide policy:
 *
 *   - `{ ok: true,  result, extractor, matchedPreferredShape }`
 *   - `{ ok: false, failure: ExtractionFailure }`
 *
 * Invariants:
 *   - `raw.exitCode !== 0`  ⇒ `{ ok: false }` (the substrate didn't
 *                              succeed; extraction can't recover that).
 *   - Empty stdout         ⇒ `{ ok: false }` (nothing to extract).
 *   - On success, `extractor` names which `NamedExtractor` won — useful
 *     test signal for "did the pipeline take the fast path?"
 *   - `matchedPreferredShape: false` ⇒ second-pass fallback hit
 *     any-parseable (lens shape rejected by predicate).
 *
 * `extractFromRunOrThrow` is common-case sugar — throws an `Error`
 * built from the `ExtractionFailure`.
 */

import { runTextStrategies } from "./run-strategies.ts";
import type { SubstrateRunResult } from "../types.ts";
import type { ExtractionFailure, JsonPipeline } from "./types.ts";

const ERROR_TEXT_TAIL_LEN = 4000;

export type ExtractFromRunResult<T> =
  | {
      readonly ok: true;
      readonly result: T;
      readonly extractor: string;
      readonly matchedPreferredShape: boolean;
    }
  | { readonly ok: false; readonly failure: ExtractionFailure };

export function extractFromRun<T>(
  raw: SubstrateRunResult,
  pipeline: JsonPipeline,
  substrateLabel: string,
): ExtractFromRunResult<T> {
  if (raw.exitCode !== 0) {
    return {
      ok: false,
      failure: {
        substrate: substrateLabel,
        kind: "exit-nonzero",
        exitCode: raw.exitCode,
        attempts: [],
        text: truncateTail(raw.stderr || raw.stdout),
      },
    };
  }

  const text = raw.stdout.trim();
  if (!text) {
    return {
      ok: false,
      failure: {
        substrate: substrateLabel,
        kind: "empty-stdout",
        attempts: [],
        text: "",
      },
    };
  }

  const outcome = runTextStrategies(text, pipeline.extractors, pipeline.preferredShape);
  if (outcome.value !== undefined && outcome.extractor !== undefined) {
    return {
      ok: true,
      result: outcome.value as T,
      extractor: outcome.extractor,
      matchedPreferredShape: outcome.matchedPreferredShape,
    };
  }

  return {
    ok: false,
    failure: {
      substrate: substrateLabel,
      kind: "no-extractor-matched",
      attempts: outcome.attempts,
      text: truncateTail(text),
    },
  };
}

export function extractFromRunOrThrow<T>(
  raw: SubstrateRunResult,
  pipeline: JsonPipeline,
  substrateLabel: string,
): { result: T; extractor: string } {
  const outcome = extractFromRun<T>(raw, pipeline, substrateLabel);
  if (outcome.ok) {
    return { result: outcome.result, extractor: outcome.extractor };
  }
  throw extractionFailureToError(outcome.failure);
}

export function extractionFailureToError(failure: ExtractionFailure): Error {
  switch (failure.kind) {
    case "exit-nonzero":
      return new Error(
        `${failure.substrate} exited with code ${failure.exitCode}: ${failure.text}`,
      );
    case "empty-stdout":
      return new Error(`${failure.substrate} returned empty stdout`);
    case "no-extractor-matched": {
      const attemptLines = failure.attempts
        .map((a) => `  - ${a.extractor}: ${a.reason}`)
        .join("\n");
      return new Error(
        `${failure.substrate} JSON extraction failed:\n${attemptLines}\n--- output (last ${ERROR_TEXT_TAIL_LEN} chars) ---\n${failure.text}`,
      );
    }
  }
}

function truncateTail(s: string): string {
  if (s.length <= ERROR_TEXT_TAIL_LEN) return s;
  return `…[truncated ${s.length - ERROR_TEXT_TAIL_LEN} chars]\n${s.slice(-ERROR_TEXT_TAIL_LEN)}`;
}
