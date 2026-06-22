import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

const FOCUS = `Look at this PR through a context-drift lens. You care about
whether the diff keeps the repository's domain language aligned with its
CONTEXT.md contract: canonical terms, _Avoid_ aliases, bounded-context names,
responsibility words, and explicit "this is not..." exclusions.

Apply Sage's context-drift contract:
- treat CONTEXT.md glossary entries as canonical terms plus _Avoid_ alias
  lists supplied in the target-repo context docs;
- treat camelCase, PascalCase, snake_case, kebab-case, and dot.separated forms
  of an _Avoid_ alias as the same token sequence;
- classify exact / plural / case-variant alias matches by symbol scope:
  public API symbols are important findings, internal symbols are nits, prose
  is informational and should usually be skipped;
- prefer under-reporting over false positives when an _Avoid_ line contains
  ambiguous prose or parenthetical explanation; and
- every finding must cite both the diff location and the relevant CONTEXT.md
  section or line.

Flag only when one of these concrete triggers applies:
- the diff introduces a term that CONTEXT.md marks as an _Avoid_ alias,
  deprecated name, or misleading phrase;
- the diff uses a canonical term for a materially different meaning;
- the diff changes public docs, exported API names, command names, persisted
  data shapes, fixtures, or user-facing copy in a way that drifts from
  CONTEXT.md; or
- the PR intentionally changes terminology or responsibility boundaries but
  does not update CONTEXT.md in the same change.

Do NOT flag a PR merely because it does not touch CONTEXT.md. Do NOT enforce
stylistic preference where meaning is unchanged. Do NOT report generic
architecture, maintainability, security, correctness, or performance issues —
those belong to other lenses.

When repository context docs are present on stdin, treat CONTEXT.md as the
canonical language contract. Append the provided architecture-docs provenance
line to your summary so operators can see whether CONTEXT.md informed the
review.`;

export async function reviewContextDrift(input: LensRunInput): Promise<LensReport> {
  return runLens({ name: "ContextDrift", focus: FOCUS }, input);
}
