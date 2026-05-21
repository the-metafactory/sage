/**
 * GitLab `ForgeReviewSource` Adapter.
 *
 * Wraps `glab api --paginate /projects/<enc>/merge_requests/N/notes` plus
 * `glab api /user`. Filters system + DiffNote types so the dedup +
 * trust-gate stages in the Module see only real-comment bodies.
 *
 * Identity caching is per-host and lives in this Adapter's closure (a
 * `Map<host, Promise<string | null>>`). A rejected lookup is evicted
 * so a transient `glab api /user` failure does not poison the cache.
 *
 * Failure modes:
 *   - `/user` throws or schema-fails  ⇒ `sageLogin: null` (the Module
 *     maps this to `trust-gate-failed`).
 *   - `/notes` throws / non-JSON / schema fail ⇒ propagated (Module
 *     maps to `source-failed`).
 */

import { z } from "zod";
import {
  DEFAULT_GITLAB_HOST,
  glabApiJson,
  formatProjectPath,
} from "../forge/gitlab/backend.ts";
import type { PrRef } from "../forge/types.ts";
import type { ForgeReviewSource, ForgeReviewBody } from "./types.ts";

export type GlabApiJson = <T>(args: string[], host: string) => Promise<T>;

export interface CreateGitLabReviewSourceOptions {
  /** Default host when `PrRef.host` is unset. Defaults to `gitlab.com`. */
  defaultHost?: string;
  /** Injectable subprocess primitive for tests. */
  glabJson?: GlabApiJson;
}

const NoteSchema = z.object({
  body: z.string(),
  author: z.object({ username: z.string() }),
  created_at: z.string(),
  system: z.boolean(),
  type: z.string().nullable(),
});

/** `glab api --paginate` may return a flat array OR an array-of-pages. */
const NotePagesSchema = z.array(z.array(NoteSchema));
const NoteFlatSchema = z.array(NoteSchema);

const UserSchema = z.object({ username: z.string() });

export function createGitLabReviewSource(
  opts: CreateGitLabReviewSourceOptions = {},
): ForgeReviewSource {
  const defaultHost = opts.defaultHost ?? DEFAULT_GITLAB_HOST;
  const glabJson: GlabApiJson = opts.glabJson ?? glabApiJson;

  // Per-Adapter-instance, per-host identity cache.
  const viewerLoginCache = new Map<string, Promise<string | null>>();

  async function resolveSageLogin(host: string): Promise<string | null> {
    const envLogin = process.env.SAGE_REVIEW_AUTHOR_LOGIN?.trim();
    if (envLogin) return envLogin;
    const cached = viewerLoginCache.get(host);
    if (cached) return cached;
    const promise = fetchViewerLogin(glabJson, host).catch((err) => {
      viewerLoginCache.delete(host);
      throw err;
    });
    // Wrap so we always cache a never-rejecting promise (eviction above
    // ensures a transient failure is retried next call).
    const wrapped: Promise<string | null> = promise.catch(() => null);
    viewerLoginCache.set(host, wrapped);
    return wrapped;
  }

  return {
    async fetchReviewBodies(ref: PrRef) {
      const host = ref.host ?? defaultHost;
      const project = encodeURIComponent(formatProjectPath(ref));
      const [rawNotes, sageLogin] = await Promise.all([
        glabJson<unknown>(
          [
            "--paginate",
            `/projects/${project}/merge_requests/${ref.number}/notes?sort=asc&per_page=100`,
          ],
          host,
        ),
        resolveSageLogin(host),
      ]);

      const refLabel = `${formatProjectPath(ref)}!${ref.number}`;
      const notes = normalizeNotes(rawNotes, refLabel);

      const bodies: ForgeReviewBody[] = notes
        .filter((n) => !n.system && n.type !== "DiffNote")
        .map((n) => ({
          authorLogin: n.author.username,
          body: n.body,
          postedAt: n.created_at,
        }));

      return { bodies, sageLogin };
    },
  };
}

function normalizeNotes(raw: unknown, refLabel: string): z.infer<typeof NoteSchema>[] {
  const paged = NotePagesSchema.safeParse(raw);
  if (paged.success) return paged.data.flat();
  const flat = NoteFlatSchema.safeParse(raw);
  if (!flat.success) {
    throw new Error(
      `glab api notes payload failed schema validation for ${refLabel}: ${flat.error.message}`,
    );
  }
  return flat.data;
}

async function fetchViewerLogin(glabJson: GlabApiJson, host: string): Promise<string> {
  const raw = await glabJson<unknown>(["/user"], host);
  const parsed = UserSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`glab api /user payload failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data.username;
}
