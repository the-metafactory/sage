/**
 * Substrate JSON extraction Module — public barrel.
 *
 * Surface: entry points + strategy lists + types. The Module is
 * Lens-shape-agnostic — callers supply their own preferred-shape
 * predicate when building a `JsonPipeline` at the call site
 * (sage#73 — refines sage#57). The Lens kernel pairs
 * `TEXT_EXTRACTORS` / `CLAUDE_EXTRACTORS` with `isLensShaped` from
 * `src/lenses/shape.ts`.
 *
 * Extractor primitives (RAW/FENCED_LAST_FIRST/BALANCED_LARGEST/
 * TRAILING/CLAUDE_ENVELOPE) are NOT re-exported — they are Module
 * internals composed into the published strategy lists. Tests that
 * need to assert against individual extractors deep-import from
 * `./extractors.ts`.
 */

export {
  extractFromRun,
  extractFromRunOrThrow,
  type ExtractFromRunResult,
} from "./extract-from-run.ts";
export { CLAUDE_EXTRACTORS, TEXT_EXTRACTORS } from "./extractors.ts";
export type {
  ExtractionAttempt,
  ExtractionFailure,
  JsonExtractor,
  JsonPipeline,
  NamedExtractor,
} from "./types.ts";
