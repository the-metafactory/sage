/**
 * Two-pass walker over a list of `NamedExtractor`s. One source of
 * truth for the resolution algorithm — called by both
 * `extract-from-run.ts` (outer Pipeline) and `CLAUDE_ENVELOPE` (inner
 * string recovery). Eliminates the duplicated candidate-building +
 * two-pass loop that previously lived inline in `CLAUDE_ENVELOPE`
 * (sage#63 round-4 Maintainability finding).
 *
 * Resolution semantics (preserved byte-for-byte from the original
 * `extractJson` in `src/substrate/json.ts`):
 *
 *   - Pass 1: walk extractors in order; if one produces a value that
 *     matches `preferredShape`, return it.
 *   - Pass 2: walk extractors in order again; return the first
 *     defined value (`preferredShape` ignored).
 *   - Memoize Pass-1 outputs so Pass 2 replays from memo without
 *     re-invoking expensive scans (fenced regex, balanced walks,
 *     trailing walks, JSON.parse).
 *
 * `ExtractionAttempt`s are returned for the per-extractor Pass-1
 * outcome — the outer Pipeline uses them for error-message context;
 * the inner CLAUDE_ENVELOPE caller ignores them.
 *
 * `preferredShape` defaults to `isLensShaped` so callers don't have
 * to thread it through when they want the same predicate the Module
 * uses by default.
 */

import { isLensShaped } from "./shape.ts";
import type {
  ExtractionAttempt,
  NamedExtractor,
} from "./types.ts";

export interface TextStrategyOutcome {
  /** Extracted value, or undefined if every strategy returned undefined. */
  readonly value: unknown | undefined;
  /** Name of the extractor whose output won, present iff `value !== undefined`. */
  readonly extractor: string | undefined;
  /** True iff Pass 1 matched the preferred shape; false on Pass-2 fallback. */
  readonly matchedPreferredShape: boolean;
  /** Per-extractor outcome from Pass 1 — for failure-message context. */
  readonly attempts: readonly ExtractionAttempt[];
}

export function runTextStrategies(
  text: string,
  extractors: readonly NamedExtractor[],
  preferredShape: (v: unknown) => boolean = isLensShaped,
): TextStrategyOutcome {
  const attempts: ExtractionAttempt[] = [];
  const memo: Array<{ name: string; value: unknown | undefined }> = [];

  // Pass 1: prefer preferredShape.
  for (const ex of extractors) {
    const value = ex.extract(text);
    memo.push({ name: ex.name, value });
    if (value === undefined) {
      attempts.push({ extractor: ex.name, reason: "undefined" });
      continue;
    }
    if (preferredShape(value)) {
      return {
        value,
        extractor: ex.name,
        matchedPreferredShape: true,
        attempts,
      };
    }
    attempts.push({ extractor: ex.name, reason: "shape-rejected" });
  }

  // Pass 2: any-parseable, replayed from memo.
  for (const slot of memo) {
    if (slot.value !== undefined) {
      return {
        value: slot.value,
        extractor: slot.name,
        matchedPreferredShape: false,
        attempts,
      };
    }
  }

  return {
    value: undefined,
    extractor: undefined,
    matchedPreferredShape: false,
    attempts,
  };
}
