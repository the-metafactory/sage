/**
 * Substrate JSON extraction Module — barrel.
 */

export {
  BALANCED_LARGEST,
  CLAUDE_ENVELOPE,
  FENCED_LAST_FIRST,
  RAW,
  TRAILING,
} from "./extractors.ts";
export {
  extractFromRun,
  extractFromRunOrThrow,
  extractionFailureToError,
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
