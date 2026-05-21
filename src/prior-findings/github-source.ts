/**
 * GitHub `ForgeReviewSource` Adapter.
 *
 * Wraps `gh api repos/.../pulls/N/reviews` (paginated + slurped) plus
 * `gh api user` for the trust-gate identity. Identity caching lives in
 * the closure returned from `createGitHubReviewSource` — there is no
 * module-level global (issue #56: kill `ghViewerLoginPromise`).
 *
 * Failure modes:
 *   - `/user` throws OR returns a malformed payload  ⇒ `sageLogin: null`
 *     (the Module maps this to `trust-gate-failed`).
 *   - `/reviews` throws / non-JSON / schema fail     ⇒ propagated as an
 *     Error (the Module maps this to `source-failed`).
 *
 * The empty `body` shape from `gh api` (server returned a review with
 * `null` body) is coerced to `""` so the markdown parser sees a string.
 */

import { z } from "zod";
import { runGh as defaultRunGh } from "../forge/github/backend.ts";
import type { PrRef } from "../forge/types.ts";
import type { ForgeReviewSource, ForgeReviewBody } from "./types.ts";

/** Subset of the gh subprocess wrapper the Adapter actually needs. */
export type RunGh = (args: string[]) => Promise<{ stdout: string }>;

export interface CreateGitHubReviewSourceOptions {
  /** Injectable for tests; defaults to the production `runGh`. */
  runGh?: RunGh;
}

const ReviewSchema = z.object({
  body: z.string().nullable().transform((s) => s ?? ""),
  user: z.object({ login: z.string() }),
  submitted_at: z.string().nullable().optional(),
});

/** `gh api --paginate --slurp` returns an array-of-pages. */
const ReviewPagesSchema = z.array(z.array(ReviewSchema));

const UserSchema = z.object({ login: z.string() });

export function createGitHubReviewSource(
  opts: CreateGitHubReviewSourceOptions = {},
): ForgeReviewSource {
  const runGh = opts.runGh ?? defaultRunGh;

  // Per-Adapter-instance identity cache. Resolves once; subsequent
  // calls return the cached promise. On rejection the cache slot is
  // evicted so a transient `gh api user` failure does not poison the
  // cache for the rest of the process lifetime — the next caller
  // re-fetches. Mirrors the GitLab Adapter's eviction-on-reject
  // pattern.
  let viewerLoginPromise: Promise<string | null> | undefined;

  async function resolveSageLogin(): Promise<string | null> {
    const envLogin = process.env.SAGE_REVIEW_AUTHOR_LOGIN?.trim();
    if (envLogin) return envLogin;
    if (!viewerLoginPromise) {
      viewerLoginPromise = fetchViewerLogin(runGh).catch(() => {
        // Evict the rejected slot so the next caller re-fetches.
        viewerLoginPromise = undefined;
        // Map to null so the Module yields `trust-gate-failed` for
        // *this* call without throwing; the next call gets a fresh
        // attempt because the eviction above ran first.
        return null;
      });
    }
    return viewerLoginPromise;
  }

  return {
    async fetchReviewBodies(ref: PrRef) {
      const [reviewsOut, sageLogin] = await Promise.all([
        runGh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
        ]),
        resolveSageLogin(),
      ]);

      let rawReviews: unknown;
      try {
        rawReviews = JSON.parse(reviewsOut.stdout);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(`gh api reviews returned non-JSON output: ${m}`);
      }

      const parsed = ReviewPagesSchema.safeParse(rawReviews);
      if (!parsed.success) {
        throw new Error(
          `gh api reviews payload failed schema validation for ${ref.owner}/${ref.repo}#${ref.number}: ${parsed.error.message}`,
        );
      }

      const bodies: ForgeReviewBody[] = parsed.data.flat().map((r) => ({
        authorLogin: r.user.login,
        body: r.body,
        ...(r.submitted_at != null ? { postedAt: r.submitted_at } : {}),
      }));

      return { bodies, sageLogin };
    },
  };
}

async function fetchViewerLogin(runGh: RunGh): Promise<string> {
  const out = await runGh(["api", "user"]);
  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`gh api user returned non-JSON output: ${m}`);
  }
  const parsed = UserSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`gh api user payload failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data.login;
}
