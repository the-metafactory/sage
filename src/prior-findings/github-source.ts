/**
 * GitHub `ForgeReviewSource` Adapter.
 *
 * Wraps the GitHub Review endpoint plus its associated PR-discussion stream,
 * selecting only Sage-rendered records from the latter, plus the `gh user`
 * endpoint for the Sage login. Sage's self-review fallback posts a Verdict as
 * a PR discussion, so both records form the Prior Findings stream. Sage-login
 * caching lives in the closure returned from `createGitHubReviewSource`
 * — there is no global cache (sage#56: kill `ghViewerLoginPromise`).
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
import { SAGE_REVIEW_HEADING_MARKER } from "../forge/prior-findings.ts";
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

const UserSchema = z.object({ login: z.string() });
const CURSOR_OVERLAP_MS = 60_000;

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
  const discussionCache = new Map<string, {
    fetchedAt: string;
    records: z.infer<typeof CommentSchema>[];
  }>();

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
      const cacheKey = `${ref.owner}/${ref.repo}#${ref.number}`;
      const cached = discussionCache.get(cacheKey);
      const reviewsOutPromise = runGh([
        "api", // glossary: allow(api) — immutable GitHub CLI subcommand.
        "--paginate",
        "--slurp",
        `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
      ]);
      const sageLogin = await resolveSageLogin();
      const [reviewsOut, commentsOut] = await Promise.all([
        reviewsOutPromise,
        fetchRenderedSageDiscussions(runGh, ref, sageLogin, cached?.fetchedAt),
      ]);

      const rawReviews = parseJson(reviewsOut.stdout, "reviews");
      const reviews = parsePages(ReviewPagesSchema, rawReviews, ref, "reviews");
      const freshDiscussions = parseRenderedSageDiscussions(commentsOut.stdout);
      const discussions = mergeDiscussions(cached?.records ?? [], freshDiscussions);
      if (sageLogin !== null) {
        discussionCache.set(cacheKey, { fetchedAt: new Date().toISOString(), records: discussions });
      }

      const bodies = [
        ...reviews.flat().map((r) => ({
          authorLogin: r.user.login,
          body: r.body,
          ...(r.submitted_at != null ? { postedAt: r.submitted_at } : {}),
          ...(r.commit_id != null ? { commitId: r.commit_id } : {}),
        })),
        ...discussions.map((c) => ({
          authorLogin: c.user.login,
          body: c.body,
          postedAt: c.created_at,
        })),
      ];

      // GitHub returns each individual stream oldest-first, but a PR discussion
      // can be interleaved with Reviews. Equal timestamps cannot establish a
      // cross-resource order; the Module rejects a conflicting tied provenance
      // marker rather than selecting a fabricated delta baseline.
      bodies.sort((a, b) => (a.postedAt ?? "").localeCompare(b.postedAt ?? ""));

      return { bodies, sageLogin };
    },
  };
}

async function fetchRenderedSageDiscussions(
  runGh: RunGh,
  ref: PrRef,
  sageLogin: string | null,
  previousFetchAt: string | undefined,
): Promise<{ stdout: string }> {
  if (sageLogin === null) return { stdout: "" };
  const login = JSON.stringify(sageLogin);
  const heading = JSON.stringify(SAGE_REVIEW_HEADING_MARKER);
  const selection = `.[] | select(.user.login == ${login} and ((.body // "") | startswith(${heading}))) | {body, user, created_at} | @json`;
  const since = previousFetchAt ? `?since=${encodeURIComponent(overlappingSince(previousFetchAt))}` : "";
  return runGh([
    "api", // glossary: allow(api) — immutable GitHub CLI subcommand.
    "--paginate",
    "--jq",
    selection,
    `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments${since}`,
  ]);
}

function overlappingSince(fetchedAt: string): string {
  return new Date(Date.parse(fetchedAt) - CURSOR_OVERLAP_MS).toISOString();
}

function mergeDiscussions(
  cached: readonly z.infer<typeof CommentSchema>[],
  fresh: readonly z.infer<typeof CommentSchema>[],
): z.infer<typeof CommentSchema>[] {
  const merged = new Map<string, z.infer<typeof CommentSchema>>();
  for (const record of [...cached, ...fresh]) {
    merged.set(`${record.user.login}\u0000${record.created_at}\u0000${record.body}`, record);
  }
  return [...merged.values()];
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

/** Decode `gh --jq ... | @json` output without retaining unrelated records. */
function parseRenderedSageDiscussions(stdout: string): z.infer<typeof CommentSchema>[] {
  if (stdout.trim() === "") return [];
  const values = stdout.trim().split(/\r?\n/).map((line) => {
    try {
      const record: unknown = JSON.parse(line);
      return typeof record === "string" ? JSON.parse(record) : record;
    } catch (err) {
      const detail = String(err);
      throw new Error(`gh comments endpoint returned invalid rendered-Sage record: ${detail}`);
    }
  });
  const parsed = z.array(CommentSchema).safeParse(values);
  if (!parsed.success) {
    throw new Error(
      `gh comments endpoint rendered-Sage record failed schema validation: ${JSON.stringify(parsed.error.issues)}`,
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
