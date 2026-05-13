import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PrRef } from "../github/gh.ts";
import type { ReviewVerdict } from "../lenses/types.ts";

/**
 * Character class for ref segments and filename slugs. Anything outside
 * the safe set becomes `_` so the resulting path is shell-safe and
 * filesystem-portable. Exported because the dispatcher prints a `cat
 * ~/.config/sage/reviews/<safe>-<safe>-<n>.md` recovery hint that must
 * match the filename `persistVerdict` actually writes here — one
 * regex, two consumers (sage#16 round-2 review).
 */
export const SAFE_FILENAME_CHAR_RE = /[^a-zA-Z0-9._-]/g;

/**
 * Build the on-disk slug for a PR ref. Shared with `dispatcher.ts`'s
 * `sanitizeRefSegment` (which produces the same shape for the printed
 * recovery hint).
 */
export function safeRefSegment(value: string): string {
  return value.replace(SAFE_FILENAME_CHAR_RE, "_");
}

/**
 * Persist a rendered review verdict to disk so a postReview failure can be
 * recovered manually. Best-effort — write errors log but don't propagate.
 *
 * Output location: ~/.config/sage/reviews/<owner>-<repo>-<number>.{json,md}
 * The .json holds the full verdict object (machine-readable); the .md is
 * the body string ready for `gh pr review --body-file`.
 *
 * Lives in src/util/ rather than src/lenses/ because file-system operations
 * are orchestration concerns, not lens-domain logic. workflow.ts only
 * orchestrates — actual persistence is a separable concern.
 */
export function persistVerdict(ref: PrRef, verdict: ReviewVerdict, body: string): void {
  try {
    const dir = join(homedir(), ".config", "sage", "reviews");
    mkdirSync(dir, { recursive: true });
    const safeRef = `${safeRefSegment(ref.owner)}-${safeRefSegment(ref.repo)}-${ref.number}`;
    const json = {
      ref,
      verdict,
      body,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, `${safeRef}.json`), JSON.stringify(json, null, 2));
    writeFileSync(join(dir, `${safeRef}.md`), body);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[sage] persistVerdict failed (non-fatal): ${m}`);
  }
}
