import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PrRef } from "../forge/types.ts";
import { safeRefSegment } from "../util/persistence.ts";
import type { Verdict } from "./types.ts";

const REVIEWS_DIR = join(homedir(), ".config", "sage", "reviews");

/**
 * Absolute path to the verdict-file for a PR ref, in either the
 * machine-readable `.json` or the `gh pr review --body-file`-ready
 * `.md` shape. One template, two consumers (`persistVerdict` here +
 * dispatcher's recovery hint) so the directory / separator / extension
 * cannot drift between them (sage#16 round-3 review).
 */
export function verdictFilePath(ref: PrRef, ext: "json" | "md"): string {
  const slug = `${safeRefSegment(ref.owner)}-${safeRefSegment(ref.repo)}-${ref.number}`;
  return join(REVIEWS_DIR, `${slug}.${ext}`);
}

/**
 * Persist a rendered Verdict to disk so a postReview failure can be
 * recovered manually. Returns `true` on success, `false` on any write
 * failure (caller decides whether to promise a recovery path that may
 * not exist on disk — sage#16 round-6 review).
 *
 * Output location: ~/.config/sage/reviews/<owner>-<repo>-<number>.{json,md}
 * The .json holds the full Verdict object (machine-readable); the .md is
 * the body string ready for `gh pr review --body-file`.
 *
 * Lives in the Verdict Module because persisting a Verdict is
 * verdict-domain logic — a Verdict knows how to save itself for
 * recovery. (Reverses the pre-#70 placement under `util/`; see #70.)
 */
export function persistVerdict(ref: PrRef, verdict: Verdict, body: string): boolean {
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
    return true;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[sage] persistVerdict failed (non-fatal): ${m}`);
    return false;
  }
}
