import type { InlineComment } from "../forge/types.ts";
import type { Finding } from "../lenses/types.ts";
import type { Verdict } from "./types.ts";

/**
 * Derive line-anchored inline review comments from a Verdict's
 * (deduped) findings (compass#99 F15).
 *
 * Only findings with a real diff anchor (`line > 0`) qualify — per
 * `Finding`'s contract, `line: 0` marks a file-level finding, and
 * errored-lens synthetic diagnostics (`buildErroredLensReport`,
 * `src/lenses/types.ts`) always carry `path: "(lens runtime)" |
 * "(lens output)"` with `line: 0`, so the `line > 0` filter excludes
 * them without a separate `errored` check. GitHub's review API
 * rejects a comment with no diff-anchored line, so these stay in the
 * top-level review body (`renderVerdict`) only.
 *
 * Pure function — same input Verdict always yields the same ordered
 * comment list, matching `renderVerdict`'s lens/finding order.
 */
export function extractInlineComments(verdict: Verdict): InlineComment[] {
  return verdict.lenses
    .filter((lens) => !lens.errored)
    .flatMap((lens) => lens.findings)
    .filter((finding) => finding.line > 0)
    .map(findingToInlineComment);
}

function findingToInlineComment(finding: Finding): InlineComment {
  return {
    path: finding.path,
    line: finding.line,
    body: renderInlineCommentBody(finding),
  };
}

function renderInlineCommentBody(finding: Finding): string {
  const head = `**[${finding.severity}] ${finding.title}**\n\n${finding.rationale}`;
  return finding.suggestion ? `${head}\n\nFix: ${finding.suggestion}` : head;
}
