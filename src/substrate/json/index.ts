/**
 * Substrate JSON extraction Module — public barrel.
 *
 * Surface kept minimal: entry points + Pipeline constants + the
 * lens-shape predicate + types. Extractor primitives
 * (RAW/FENCED_LAST_FIRST/BALANCED_LARGEST/TRAILING/CLAUDE_ENVELOPE)
 * are NOT re-exported — they are Module internals composed into
 * Pipelines. Tests that need to assert against individual extractors
 * deep-import from `./extractors.ts` (sage#63 round-4 Maintainability
 * suggestion: keep the public surface tight so extractor changes
 * aren't breaking).
 */

export {
  extractFromRun,
  extractFromRunOrThrow,
  type ExtractFromRunResult,
} from "./extract-from-run.ts";
export { CLAUDE_PIPELINE, TEXT_PIPELINE } from "./pipelines.ts";
export { isLensShaped } from "./shape.ts";
export type {
  ExtractionAttempt,
  ExtractionFailure,
  JsonExtractor,
  JsonPipeline,
  NamedExtractor,
} from "./types.ts";
