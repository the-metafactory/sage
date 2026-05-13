import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PrRef } from "../github/gh.ts";
import type { ReviewVerdict } from "../lenses/types.ts";

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
    const safeRef = `${ref.owner}-${ref.repo}-${ref.number}`.replace(/[^a-zA-Z0-9._-]/g, "_");
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
