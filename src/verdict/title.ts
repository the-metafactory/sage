/**
 * Finding-title normalization, shared by the two places that compare titles:
 * cross-lens deduplication (`decide.ts`, same round) and repeat detection
 * (`repeats.ts`, across rounds).
 *
 * Kept in one module so the two never drift apart. Two lenses phrasing the same
 * finding differently within a round, and one lens rephrasing its own finding
 * between rounds, are the same problem seen at two timescales; they should not
 * disagree about what counts as a word.
 */

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/** Lowercased, punctuation-stripped, stop-words removed, original order kept. */
export function normalizeTitle(title: string): string {
  return titleWords(title).join(" ");
}

/** The same normalization as a set, for order-independent comparison. */
export function titleTokens(title: string): Set<string> {
  return new Set(titleWords(title));
}

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !TITLE_STOP_WORDS.has(word));
}
