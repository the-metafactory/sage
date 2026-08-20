/**
 * GitHub `ForgeReviewSource` Adapter.
 *
 * Wraps both the GitHub Review endpoint and its associated PR-discussion
 * records (each paginated + slurped), plus the `gh user` endpoint for the Sage
 * login. Sage's self-review fallback posts a Verdict as a PR discussion, so
 * both records form the Prior Findings stream. Sage-login caching lives in the
 * closure returned from `createGitHubReviewSource`
 * — there is no module-level global (sage#56: kill `ghViewerLoginPromise`).
 *
 * Failure modes:
 *   - `/user` throws OR returns a malformed payload  ⇒ `sageLogin: null`
 *     (the Module maps this to its trust-boundary failure state).
 *   - `/reviews` throws / non-JSON / schema fail     ⇒ propagated as an
 *     Error (the Module maps this to `source-failed`).
 *
 * The empty `body` shape from `gh api` (server returned a review with
 * `null` body) is coerced to `""` so the markdown parser sees a string.
 */

import { z } from "zod";
import { runGh as defaultRunGh } from "../forge/github/backend.ts";
import type { PrRef } from "../forge/types.ts";
import type { ForgeReviewSource } from "./types.ts";

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
  commit_id: z.string().nullable().optional(),
});

/** `gh api --paginate --slurp` returns an array-of-pages. */
const ReviewPagesSchema = z.array(z.array(ReviewSchema));

const CommentSchema = z.object({
  body: z.string().nullable().transform((s) => s ?? ""),
  user: z.object({ login: z.string() }),
  created_at: z.string(),
});

const CommentPagesSchema = z.array(z.array(CommentSchema));

const UserSchema = z.object({ login: z.string() });

export function createGitHubReviewSource(
  opts: CreateGitHubReviewSourceOptions = {},
): ForgeReviewSource {
  const runGh = opts.runGh ?? defaultRunGh;

  // Per-Adapter-instance Sage-login cache. Resolves once; subsequent
  // calls return the cached promise. On rejection the cache slot is
  // evicted so a transient GitHub CLI user lookup failure does not poison the
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
      const [reviewsOut, commentsOut, sageLogin] = await Promise.all([
        runGh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
        ]),
        runGh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
        ]),
        resolveSageLogin(),
      ]);

      const rawReviews = parseJson(reviewsOut.stdout, "reviews");
      const rawComments = parseJson(commentsOut.stdout, "comments");
      const reviews = parsePages(ReviewPagesSchema, rawReviews, ref, "reviews");
      const comments = parsePages(CommentPagesSchema, rawComments, ref, "comments");

      const bodies = [
        ...reviews.flat().map((r) => ({
          authorLogin: r.user.login,
          body: r.body,
          ...(r.submitted_at != null ? { postedAt: r.submitted_at } : {}),
          ...(r.commit_id != null ? { commitId: r.commit_id } : {}),
        })),
        ...comments.flat().map((c) => ({
          authorLogin: c.user.login,
          body: c.body,
          postedAt: c.created_at,
        })),
      ];

      // GitHub returns each individual stream oldest-first, but a PR discussion
      // can be interleaved with Reviews. The Module's "last one wins" provenance
      // policy needs the combined stream oldest-first too.
      bodies.sort((a, b) => (a.postedAt ?? "").localeCompare(b.postedAt ?? ""));

      return { bodies, sageLogin };
    },
  };
}

function parseJson(stdout: string, source: "reviews" | "comments"): unknown {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    const detail = String(err);
    throw new Error(`gh ${source} endpoint returned non-JSON output: ${detail}`);
  }
}

function parsePages<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  ref: PrRef,
  source: "reviews" | "comments",
): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `gh ${source} endpoint payload failed schema validation for ${ref.owner}/${ref.repo}#${ref.number}: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

async function fetchViewerLogin(runGh: RunGh): Promise<string> {
  const out = await runGh(["api", "user"]);
  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout);
  } catch (err) {
    const detail = String(err);
    throw new Error(`gh user endpoint returned non-JSON output: ${detail}`);
  }
  const parsed = UserSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `gh user endpoint payload failed schema validation: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data.login;
}
