/**
 * Character class for ref segments and filename slugs. Anything outside
 * the safe set becomes `_` so the resulting path is shell-safe and
 * filesystem-portable. Internal — callers should go through
 * `safeRefSegment`.
 */
const SAFE_FILENAME_CHAR_RE = /[^a-zA-Z0-9._-]/g;

/**
 * Build the on-disk slug for a single ref segment (owner or repo).
 * Shared between the Verdict Module's `verdictFilePath` and
 * `dispatcher.ts`'s `sanitizeRefSegment` so the dispatcher's printed
 * recovery hint matches the filename `persistVerdict` writes
 * (sage#16 round-3 review).
 *
 * Kept under `src/util/` (rather than moved into `src/verdict/`)
 * because the helper is a generic filename sanitizer — not
 * Verdict-specific. The dispatcher's recovery-hint code path uses it
 * without going through the Verdict Module.
 */
export function safeRefSegment(value: string): string {
  return value.replace(SAFE_FILENAME_CHAR_RE, "_");
}
