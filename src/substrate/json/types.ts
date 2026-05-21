/**
 * Substrate JSON extraction Module — types.
 *
 * Substrate is pure platform (subprocess + capture). JSON extraction
 * is its own Module: each Substrate Adapter declares a `JsonPipeline`
 * as data, and the entry point `extractFromRun` runs the Pipeline
 * against captured `SubstrateRunResult` text. Lens callers see one
 * Module, one entry point — they no longer route through
 * `substrate.runJson` indirection (sage#57).
 */

/**
 * An extractor maps raw substrate text to a candidate JSON value.
 * `undefined` ⇒ the strategy did not apply (no fenced block found,
 * no balanced object, etc.); the next extractor in the Pipeline is
 * tried.
 */
export type JsonExtractor = (text: string) => unknown | undefined;

export interface NamedExtractor {
  readonly name: string;
  readonly extract: JsonExtractor;
}

/**
 * A `JsonPipeline` is an ordered list of `NamedExtractor`s plus a
 * preferred-shape predicate. Resolution is two-pass:
 *   1. Walk extractors in order; first whose output matches
 *      `preferredShape` wins.
 *   2. Walk extractors in order again; first whose output parses to
 *      anything wins (`preferredShape` ignored).
 *   3. Both passes failed ⇒ `ExtractionFailure`.
 *
 * Two-pass shape preserves the byte-for-byte semantics of the
 * original `extractJson` in `src/substrate/json.ts` (sage#57
 * acceptance criterion).
 */
export interface JsonPipeline {
  readonly extractors: readonly NamedExtractor[];
  readonly preferredShape: (value: unknown) => boolean;
}

/**
 * Per-extractor attempt outcome carried on `ExtractionFailure`.
 *
 *   - `"undefined"`      — strategy did not apply (no fenced block,
 *                          no balanced object, no envelope shape).
 *                          `tryJsonParse` failures inside the
 *                          extractor surface here too — the extractor
 *                          swallows the parse error and returns
 *                          `undefined`.
 *   - `"shape-rejected"` — extractor produced a value but the
 *                          Pipeline's `preferredShape` rejected it
 *                          on Pass 1.
 */
export interface ExtractionAttempt {
  readonly extractor: string;
  readonly reason: "undefined" | "shape-rejected";
}

export interface ExtractionFailure {
  readonly substrate: string;
  readonly attempts: readonly ExtractionAttempt[];
  /** Truncated tail of the raw text for error-message context. */
  readonly text: string;
}
