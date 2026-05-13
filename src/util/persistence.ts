import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PrRef } from "../github/gh.ts";
import type { ReviewVerdict } from "../lenses/types.ts";

/**
 * Character class for ref segments and filename slugs. Anything outside
 * the safe set becomes `_` so the resulting path is shell-safe and
 * filesystem-portable. Internal — callers should go through
 * `safeRefSegment` or `verdictFilePath`.
 */
const SAFE_FILENAME_CHAR_RE = /[^a-zA-Z0-9._-]/g;

const REVIEWS_DIR = join(homedir(), ".config", "sage", "reviews");

/**
 * Build the on-disk slug for a single ref segment (owner or repo).
 * Shared with `dispatcher.ts`'s `sanitizeRefSegment` so the dispatcher's
 * printed recovery hint matches the filename `persistVerdict` writes.
 */
export function safeRefSegment(value: string): string {
  return value.replace(SAFE_FILENAME_CHAR_RE, "_");
}

/**
 * Absolute path to the verdict-file for a PR ref, in either the
 * machine-readable `.json` or the `gh pr review --body-file`-ready
 * `.md` shape. One template, two consumers (persistVerdict here +
 * dispatcher's recovery hint) so the directory / separator / extension
 * cannot drift between them (sage#16 round-3 review).
 */
export function verdictFilePath(ref: PrRef, ext: "json" | "md"): string {
  const slug = `${safeRefSegment(ref.owner)}-${safeRefSegment(ref.repo)}-${ref.number}`;
  return join(REVIEWS_DIR, `${slug}.${ext}`);
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
    mkdirSync(REVIEWS_DIR, { recursive: true });
    const json = {
      ref,
      verdict,
      body,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(verdictFilePath(ref, "json"), JSON.stringify(json, null, 2));
    writeFileSync(verdictFilePath(ref, "md"), body);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[sage] persistVerdict failed (non-fatal): ${m}`);
  }
}
