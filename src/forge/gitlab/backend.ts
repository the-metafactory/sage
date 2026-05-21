import { spawn } from "node:child_process";
import { mkdtemp, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGlabEnv } from "./env.ts";
import { retryTransient } from "../../util/retry.ts";
import { createGitLabReviewSource } from "../../prior-findings/gitlab-source.ts";
import { PrMetadataSchema } from "../types.ts";
import type {
  AuthStatusResult,
  ForgeBackend,
  ForgeReviewSource,
  PostReviewInput,
  PostReviewResult,
  PrMetadata,
  PrRef,
  ReviewEvent,
} from "../types.ts";

/**
 * GitLab adapter — wraps the `glab` CLI. Mirrors the design of the
 * GitHub backend: piggyback on `glab auth login` for credentials, talk
 * to GitLab via subprocess instead of a maintained HTTP client.
 *
 * Mapping primitives + `glab api` JSON wrapper are derived from
 * `the-metafactory/pilot` `src/forge/gitlab-backend.ts`
 * (spec `0004-forge-abstraction-gitlab.md`). Pilot's interface is
 * reviewee-side (rich note + counters + merge surface); sage's
 * `ForgeBackend` is reviewer-side (diff fetch + body post). The
 * mapping functions translate the same `glab` JSON shapes either
 * direction.
 *
 * Self-hosted instances: the constructor takes a `host` string. When
 * a `PrRef.host` is set it overrides the constructor default. `glab
 * --hostname` accepts the host on every call so a single backend
 * instance can address multiple GitLab instances (e.g., gitlab.com
 * and a private gitlab.example.com) without re-construction.
 */

export const DEFAULT_GITLAB_HOST = "gitlab.com";

/**
 * URL forms the parser recognizes:
 *
 *   - `https://<host>/group(/sub)*\/project/-/merge_requests/N`
 *   - `<group>(/sub)*\/<project>!N` (shorthand; `!` distinguishes from GitHub's `#`)
 */
const MR_URL_RE = /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)\b/;
const PROJECT_BANG_RE = /^([^!\s]+)!(\d+)$/;

export function parsePrRef(input: string): PrRef {
  const trimmed = input.trim();

  let m = trimmed.match(MR_URL_RE);
  if (m && m[1] && m[2] && m[3]) {
    const projectPath = m[2];
    const { owner, repo } = splitProjectPath(projectPath);
    return {
      kind: "gitlab",
      owner,
      repo,
      number: Number(m[3]),
      host: m[1],
    };
  }

  m = trimmed.match(PROJECT_BANG_RE);
  if (m && m[1] && m[2]) {
    const { owner, repo } = splitProjectPath(m[1]);
    return {
      kind: "gitlab",
      owner,
      repo,
      number: Number(m[2]),
    };
  }

  throw new Error(
    `unrecognized GitLab MR reference: "${input}" — expected https://HOST/GROUP/PROJ/-/merge_requests/N or GROUP/PROJ!N`,
  );
}

/**
 * Split a project path into `{ owner, repo }`. GitLab projects can be
 * nested (`group/sub/project`); `owner` absorbs every segment except
 * the last so `formatProjectPath` round-trips through
 * `{ owner: "group/sub", repo: "project" }`.
 */
export function splitProjectPath(path: string): { owner: string; repo: string } {
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new Error(`GitLab project path must have at least 2 segments: "${path}"`);
  }
  const repo = segments[segments.length - 1]!;
  const owner = segments.slice(0, -1).join("/");
  return { owner, repo };
}

export function formatProjectPath(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}`;
}

function encodeProject(ref: PrRef): string {
  return encodeURIComponent(formatProjectPath(ref));
}

// --- Raw GitLab API shapes (subset; exported so tests can pin against them) ---

export interface GlMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merged_at: string | null;
  sha: string;
  source_branch: string;
  diff_refs: { base_sha: string; head_sha: string; start_sha: string } | null;
  target_branch: string;
  web_url: string;
  author: { username: string };
  changes_count?: string;
}

export interface GlMrChanges {
  changes: Array<{
    new_path: string;
    old_path: string;
    diff: string;
  }>;
}

export interface GlNote {
  id: number;
  body: string;
  author: { username: string };
  created_at: string;
  system: boolean;
  type: string | null;
  position?: {
    new_path: string | null;
    new_line: number | null;
    old_line: number | null;
  } | null;
}

export interface GlApproval {
  approved: boolean;
  approvals_left: number;
  approved_by: Array<{ user: { username: string } }>;
}

// --- Pure mappers (exported for direct unit testing) ---

/**
 * Map a raw GitLab MR payload + file-level changes count into the
 * forge-neutral `PrMetadata` shape. GitLab does not expose
 * `additions`/`deletions` totals at the MR level the way GitHub does;
 * synthesize them by summing per-file diffs from the `/changes`
 * endpoint. The `changes_count` string GitLab returns is an opaque
 * label like `"3 files"`; we ignore it and count from the array.
 */
export function mapGlMrToPrMetadata(
  mr: GlMergeRequest,
  changes: GlMrChanges,
): PrMetadata {
  const files = changes.changes.map((c) => {
    const { additions, deletions } = countDiffLines(c.diff);
    return { path: c.new_path || c.old_path, additions, deletions };
  });
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return PrMetadataSchema.parse({
    number: mr.iid,
    title: mr.title,
    body: mr.description,
    // Normalize GitLab `state` to the GitHub-compat lexicon sage's
    // lenses already key off (`open`, `closed`, `merged`).
    state: mr.state === "opened" ? "open" : mr.state,
    isDraft: mr.draft ?? mr.work_in_progress ?? false,
    baseRefName: mr.target_branch,
    headRefName: mr.source_branch,
    author: { login: mr.author.username },
    changedFiles: files.length,
    additions,
    deletions,
    files,
    url: mr.web_url,
  });
}

/**
 * Count `+`/`-` lines in a unified diff fragment. Skips file-header
 * lines (`+++` / `---`) so they don't double-count against
 * additions/deletions.
 */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * Concatenate per-file diffs from a `/changes` response into a single
 * unified-diff blob mirroring `gh pr diff` / `glab mr diff` stdout
 * shape — `diff --git` headers wrap each file. Used by `prDiff` so
 * sage's diff-consuming lenses see the same patch format on both
 * forges.
 */
export function stitchUnifiedDiff(changes: GlMrChanges): string {
  return changes.changes
    .map((c) => {
      const oldPath = c.old_path || c.new_path;
      const newPath = c.new_path || c.old_path;
      const header = `diff --git a/${oldPath} b/${newPath}\n`;
      // Ensure each per-file chunk ends with a newline so the next
      // `diff --git` header starts at column 0 even when glab returns a
      // trimmed final hunk (sage review on #46, CodeQuality suggestion).
      const body = c.diff.endsWith("\n") ? c.diff : `${c.diff}\n`;
      return header + body;
    })
    .join("");
}

// --- Module-level operations ---

async function glabJson<T>(
  args: string[],
  host: string,
  opts: { allowNonZero?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const out = await runGlab(["api", "--hostname", host, ...args], opts);
  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const sample = out.stdout.slice(0, 200).replace(/\s+/g, " ");
    const truncated = out.stdout.length > 200 ? "…" : "";
    throw new Error(
      `glab api ${args[0]} returned non-JSON output: ${m}\n  first 200 chars: "${sample}${truncated}"`,
    );
  }
  return raw as T;
}

/**
 * Exported subprocess + JSON helper for use by the GitLab
 * `ForgeReviewSource` Adapter (`src/prior-findings/gitlab-source.ts`).
 * Same shape as the internal `glabJson` — exists at module scope so the
 * Adapter can reuse env-building, hostname routing, and JSON-error
 * messages without duplicating subprocess code.
 */
export const glabApiJson = glabJson;

function resolveHost(ref: PrRef, fallback: string): string {
  return ref.host ?? fallback;
}

export async function prView(ref: PrRef, fallbackHost: string = DEFAULT_GITLAB_HOST): Promise<PrMetadata> {
  const host = resolveHost(ref, fallbackHost);
  const project = encodeProject(ref);
  const [mr, changes] = await Promise.all([
    glabJson<GlMergeRequest>([`/projects/${project}/merge_requests/${ref.number}`], host),
    glabJson<GlMrChanges>([`/projects/${project}/merge_requests/${ref.number}/changes`], host),
  ]);
  return mapGlMrToPrMetadata(mr, changes);
}

export async function prDiff(ref: PrRef, fallbackHost: string = DEFAULT_GITLAB_HOST): Promise<string> {
  const host = resolveHost(ref, fallbackHost);
  const project = encodeProject(ref);
  const changes = await glabJson<GlMrChanges>(
    [`/projects/${project}/merge_requests/${ref.number}/changes`],
    host,
  );
  return stitchUnifiedDiff(changes);
}

/**
 * Map a sage `ReviewEvent` to the sequence of GitLab API calls.
 *
 * GitLab has no single "post a review with an event" endpoint:
 *   - `comment` → POST `/notes` (body comment)
 *   - `approve` → POST `/approve` THEN POST `/notes`
 *   - `request-changes` → POST `/unapprove` THEN POST `/notes`
 *
 * If the approve/unapprove call returns a "self-review" / "cannot
 * approve your own MR" 4xx, we fall back to `comment` (same policy
 * shape as `postReviewWithFallback` for GitHub).
 */
/**
 * GitLab error wording for the "user cannot approve / unapprove their
 * own MR" rejection. Narrowed in PR #46 review: an earlier draft
 * accepted bare `access denied`, but that pattern matches unrelated
 * permission failures (revoked token, project visibility, etc.) and
 * could downgrade a real failure to a comment-only fallback. Match
 * only wording that explicitly mentions self-approval or that the
 * action is approval-related.
 */
export const SELF_REVIEW_BLOCK_RE_GITLAB =
  /cannot approve|cannot unapprove|user cannot approve (?:own|their own)|self.?approval/i;

export interface GitLabPostReviewDeps {
  approve: () => Promise<void>;
  unapprove: () => Promise<void>;
  postNote: () => Promise<void>;
  log?: (msg: string) => void;
}

export async function postReviewWithFallback(
  event: ReviewEvent,
  deps: GitLabPostReviewDeps,
): Promise<PostReviewResult> {
  const log =
    deps.log ??
    ((m) => {
      // eslint-disable-next-line no-console
      console.error(m);
    });

  if (event === "comment") {
    await deps.postNote();
    return { posted: "comment", downgraded: false };
  }

  try {
    if (event === "approve") {
      await deps.approve();
    } else {
      await deps.unapprove();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (SELF_REVIEW_BLOCK_RE_GITLAB.test(msg)) {
      log(`[sage] glab blocked self-${event}; falling back to comment-only`);
      await deps.postNote();
      return { posted: "comment", downgraded: true };
    }
    throw err;
  }

  // Approval/unapproval succeeded — still post the body note so sage's
  // verdict text is visible alongside the approve action.
  await deps.postNote();
  return { posted: event, downgraded: false };
}

export async function postReview(
  input: PostReviewInput,
  fallbackHost: string = DEFAULT_GITLAB_HOST,
): Promise<PostReviewResult> {
  const host = resolveHost(input.ref, fallbackHost);
  const project = encodeProject(input.ref);

  // Body via temp file: a full review body (many findings + fenced
  // suggestions) easily exceeds macOS ARG_MAX (~256 KB), so we never
  // pass it on the argv. Async fs API so daemon-mode posting doesn't
  // block the event loop on large bodies (sage review on #46,
  // Performance lens).
  const tmpDir = await mkdtemp(join(tmpdir(), "sage-glab-"));
  const bodyPath = join(tmpDir, "body.md");
  await writeFile(bodyPath, input.body);

  const wrap = <T>(fn: () => Promise<T>) =>
    retryTransient(fn, {
      maxAttempts: 6,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      onRetry: (attemptNum, delayMs, err) => {
        const m = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(
          `[sage] glab attempt ${attemptNum} failed transient; retrying in ${delayMs}ms: ${m.split("\n")[0]}`,
        );
      },
    });

  // Shared command builder so timeout/retry/API-shape changes happen
  // in one place across the three post-review actions (sage review on
  // #46, Maintainability lens).
  const postMr = (pathSuffix: string, extra: string[] = []) =>
    wrap(() =>
      runGlab(
        [
          "api",
          "--hostname",
          host,
          "-X",
          "POST",
          `/projects/${project}/merge_requests/${input.ref.number}${pathSuffix}`,
          ...extra,
        ],
        { timeoutMs: 60_000 },
      ),
    ).then(() => undefined);

  const deps: GitLabPostReviewDeps = {
    approve: () => postMr("/approve"),
    unapprove: () => postMr("/unapprove"),
    postNote: () => postMr("/notes", ["-F", `body=@${bodyPath}`]),
  };

  try {
    return await postReviewWithFallback(input.event, deps);
  } finally {
    try {
      await unlink(bodyPath);
    } catch {
      // Best-effort cleanup.
    }
    try {
      await rm(tmpDir, { recursive: false, force: false });
    } catch {
      // Best-effort cleanup.
    }
  }
}

export async function glabAuthStatus(
  host: string = DEFAULT_GITLAB_HOST,
): Promise<AuthStatusResult> {
  try {
    const out = await runGlab(["auth", "status", "--hostname", host], {
      allowNonZero: true,
    });
    return { ok: out.exitCode === 0, output: out.stdout + out.stderr };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg };
  }
}

interface RunGlabResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_GLAB_TIMEOUT_MS = 30_000;

export async function runGlab(
  args: string[],
  opts: { allowNonZero?: boolean; timeoutMs?: number } = {},
): Promise<RunGlabResult> {
  const bin = process.env.GLAB_BIN ?? "glab";
  const childEnv = buildGlabEnv();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GLAB_TIMEOUT_MS;

  return new Promise<RunGlabResult>((resolve, reject) => {
    const child = spawn(bin, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Hard timeout so a hung glab (token-prompt, network partition)
    // cannot block a semaphore slot indefinitely in daemon mode.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`glab ${args.join(" ")} timed out after ${timeoutMs}ms`));
        return;
      }
      const exitCode = code ?? -1;
      if (exitCode !== 0 && !opts.allowNonZero) {
        reject(new Error(`glab ${args.join(" ")} failed (exit ${exitCode}): ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * `ForgeBackend` adapter for GitLab. Instances carry a default host
 * for when `PrRef.host` is unset (a single-instance operator usually
 * just configures `gitlab.com` once).
 */
export class GitLabBackend implements ForgeBackend {
  readonly kind = "gitlab" as const;
  readonly defaultHost: string;

  /**
   * Per-backend-instance review source. The Adapter holds a per-host
   * identity cache in its closure; sharing one Adapter across Reviews
   * keeps the cache hot.
   */
  private _reviewSource?: ForgeReviewSource;

  constructor(opts: { defaultHost?: string } = {}) {
    this.defaultHost = opts.defaultHost ?? DEFAULT_GITLAB_HOST;
  }

  parseRef(input: string): PrRef {
    return parsePrRef(input);
  }

  prView(ref: PrRef): Promise<PrMetadata> {
    return prView(ref, this.defaultHost);
  }

  prDiff(ref: PrRef): Promise<string> {
    return prDiff(ref, this.defaultHost);
  }

  postReview(input: PostReviewInput): Promise<PostReviewResult> {
    return postReview(input, this.defaultHost);
  }

  reviewSource(): ForgeReviewSource {
    if (!this._reviewSource) {
      this._reviewSource = createGitLabReviewSource({ defaultHost: this.defaultHost });
    }
    return this._reviewSource;
  }

  authStatus(): Promise<AuthStatusResult> {
    return glabAuthStatus(this.defaultHost);
  }
}
