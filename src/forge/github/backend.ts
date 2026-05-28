import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGhEnv } from "./env.ts";
import { retryTransient } from "../../util/retry.ts";
import { createGitHubReviewSource } from "../../prior-findings/github-source.ts";
import { PrMetadataSchema } from "../types.ts";
import { parseSageReviewFindings } from "../prior-findings.ts";
import type {
  AuthStatusResult,
  ForgeBackend,
  ForgeReviewSource,
  PostReviewInput,
  PostReviewResult,
  PrMetadata,
  PrRef,
  RepoFileOptions,
  ReviewEvent,
} from "../types.ts";

/**
 * Re-export of the canonical `PrMetadataSchema` (now owned by
 * `../types.ts`) so the historical `import { PrMetadataSchema } from
 * "src/github/gh.ts"` surface still resolves through the relocated
 * module. Folds in once all callers migrate to importing from
 * `forge/types.ts` directly.
 */
export { PrMetadataSchema };

/**
 * GitHub adapter — wraps the `gh` CLI. Piggybacks on the user's existing
 * `gh auth` login so sage doesn't juggle PATs or speak Octokit; review
 * ops are scoped to `gh pr review --comment` events by default.
 *
 * Implements `ForgeBackend` for the `"github"` kind. The class is a
 * thin facade over the module-level functions below — those functions
 * stay exported so existing call sites compile during the sage#43
 * Phase 5 wire-up window. New code should consume the class via
 * `selectForge()`; the module exports will fold into the class once all
 * callers route through the abstraction.
 */

const PR_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\b/;
const OWNER_REPO_HASH_RE = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;

export function parsePrRef(input: string): PrRef {
  const trimmed = input.trim();
  let m = trimmed.match(PR_URL_RE);
  if (m && m[1] && m[2] && m[3]) {
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  m = trimmed.match(OWNER_REPO_HASH_RE);
  if (m && m[1] && m[2] && m[3]) {
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  throw new Error(
    `unrecognized PR reference: "${input}" — expected https://github.com/OWNER/REPO/pull/N or OWNER/REPO#N`,
  );
}

export function formatRepo(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}`;
}

const PR_VIEW_FIELDS =
  "number,title,body,state,isDraft,baseRefName,headRefName,author,changedFiles,additions,deletions,files,url";

export async function prView(ref: PrRef): Promise<PrMetadata> {
  const out = await runGh([
    "pr",
    "view",
    String(ref.number),
    "--repo",
    formatRepo(ref),
    "--json",
    PR_VIEW_FIELDS,
  ]);

  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const sample = out.stdout.slice(0, 200).replace(/\s+/g, " ");
    const truncated = out.stdout.length > 200 ? "…" : "";
    throw new Error(
      `gh pr view returned non-JSON output: ${m}\n  first 200 chars: "${sample}${truncated}"`,
    );
  }

  const parsed = PrMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `gh pr view payload failed schema validation for ${formatRepo(ref)}#${ref.number}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export async function prDiff(ref: PrRef): Promise<string> {
  const out = await runGh(["pr", "diff", String(ref.number), "--repo", formatRepo(ref)]);
  return out.stdout;
}

function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function repoFile(
  ref: PrRef,
  path: string,
  opts: RepoFileOptions = {},
): Promise<string | null> {
  const encodedPath = encodeRepoPath(path);
  const refQuery = opts.refName ? `?ref=${encodeURIComponent(opts.refName)}` : "";
  const endpoint = `repos/${formatRepo(ref)}/contents/${encodedPath}${refQuery}`;
  const out = await runGh(
    ["api", "-H", "Accept: application/vnd.github.raw", endpoint],
    { allowNonZero: true },
  );

  if (out.exitCode === 0) return out.stdout;

  const message = `${out.stderr}\n${out.stdout}`;
  if (/HTTP 404|Not Found/i.test(message)) return null;
  throw new Error(`gh api ${endpoint} failed (exit ${out.exitCode}): ${message.trim()}`);
}

/**
 * Error family GH returns when the authenticated user equals the PR author
 * and tries to approve / request-changes their own PR.
 *
 * Match only the STABLE semantic core — "your own pull request" — not the
 * full sentence. The leading prose drifts ("Can not" vs "Cannot", GraphQL vs
 * REST phrasing, occasional rewordings), and the old full-sentence regex
 * (`/Can not (?:approve|request changes on) your own pull request/`) silently
 * stopped matching the live wording → approved verdicts on self-authored PRs
 * posted NOTHING (cortex#422 / sage#75). The `--comment` event is always
 * allowed and never produces this, so this stays self-review-specific:
 * transient (502), auth (401), and validation ("Body is too long") failures
 * don't contain the phrase and correctly propagate without a silent downgrade.
 */
export const SELF_REVIEW_BLOCK_RE = /your own pull request/i;

function eventFlag(event: ReviewEvent): string {
  return event === "approve"
    ? "--approve"
    : event === "request-changes"
      ? "--request-changes"
      : "--comment";
}

/**
 * Pure fallback policy, extracted for testability. Attempts `attempt(event)`;
 * if it throws with the self-review GraphQL block AND the event is not already
 * `comment`, retries once with `comment`. Any other failure (including a
 * `comment` failure) propagates without further retry.
 *
 * The caller wraps `attempt` in `retryTransient` so transient network errors
 * are already absorbed before they reach this policy.
 */
export async function postReviewWithFallback(
  event: ReviewEvent,
  attempt: (event: ReviewEvent) => Promise<unknown>,
  log: (msg: string) => void = (m) => {
    // eslint-disable-next-line no-console
    console.error(m);
  },
): Promise<PostReviewResult> {
  try {
    await attempt(event);
    return { posted: event, downgraded: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (event !== "comment" && SELF_REVIEW_BLOCK_RE.test(msg)) {
      log(`[sage] gh blocked self-${event}; falling back to --comment`);
      await attempt("comment");
      return { posted: "comment", downgraded: true };
    }
    throw err;
  }
}

export async function postReview(input: PostReviewInput): Promise<PostReviewResult> {
  // Use --body-file with a temp file rather than --body in argv. A review
  // body with many findings + fenced suggestions easily exceeds macOS
  // ARG_MAX (~256 KB). Temp file path is short; the body itself is read
  // from disk by gh.
  const tmpDir = mkdtempSync(join(tmpdir(), "sage-review-"));
  const bodyPath = join(tmpDir, "body.md");
  writeFileSync(bodyPath, input.body);

  const attempt = (event: ReviewEvent) =>
    // Retry on transient network errors (operator walking between rooms
    // is a real case — laptop WLAN re-association takes ~30-60s). Auth
    // / validation errors propagate immediately, no retry.
    retryTransient(
      () =>
        runGh(
          [
            "pr",
            "review",
            String(input.ref.number),
            "--repo",
            formatRepo(input.ref),
            eventFlag(event),
            "--body-file",
            bodyPath,
          ],
          { timeoutMs: 60_000 },
        ),
      {
        maxAttempts: 6,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
        onRetry: (attemptNum, delayMs, err) => {
          const m = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(
            `[sage] gh pr review (${event}) attempt ${attemptNum} failed transient; retrying in ${delayMs}ms: ${m.split("\n")[0]}`,
          );
        },
      },
    );

  try {
    return await postReviewWithFallback(input.event, attempt);
  } finally {
    try {
      unlinkSync(bodyPath);
    } catch {
      // Best-effort cleanup; tempdir is in OS-managed /tmp anyway.
    }
    try {
      rmdirSync(tmpDir);
    } catch {
      // Empty-directory cleanup is best-effort; another process may have
      // written into it (unlikely under the mkdtemp pattern, but safe).
    }
  }
}

/**
 * Re-export of the canonical `parseSageReviewFindings` (now owned by
 * `../prior-findings.ts`) so historical
 * `import { parseSageReviewFindings } from "src/forge/github/backend.ts"`
 * call sites keep resolving. Folds in once all callers migrate.
 */
export { parseSageReviewFindings };

export async function ghAuthStatus(): Promise<AuthStatusResult> {
  try {
    const out = await runGh(["auth", "status"], { allowNonZero: true });
    return { ok: out.exitCode === 0, output: out.stdout + out.stderr };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg };
  }
}

export interface RunGhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_GH_TIMEOUT_MS = 30_000;

/**
 * Subprocess wrapper around the `gh` CLI. Exported so the
 * `ForgeReviewSource` Adapter in `src/prior-findings/github-source.ts`
 * can reuse the same env-building / timeout / stderr-capture path
 * without duplicating spawn code.
 */
export async function runGh(
  args: string[],
  opts: { allowNonZero?: boolean; timeoutMs?: number } = {},
): Promise<RunGhResult> {
  const bin = process.env.GH_BIN ?? "gh";
  const childEnv = buildGhEnv();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;

  return new Promise<RunGhResult>((resolve, reject) => {
    const child = spawn(bin, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Hard timeout so a hung gh (SSH prompt, credential-helper dialog,
    // network partition) cannot block a semaphore slot forever in daemon
    // mode. SIGKILL because some gh subcommands trap SIGTERM for their
    // own cleanup and would hang anyway.
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
        reject(new Error(`gh ${args.join(" ")} timed out after ${timeoutMs}ms`));
        return;
      }
      const exitCode = code ?? -1;
      if (exitCode !== 0 && !opts.allowNonZero) {
        reject(new Error(`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * `ForgeBackend` adapter for GitHub. Thin facade over the module-level
 * functions above; instances are stateless beyond the process-level
 * `ghViewerLogin` cache. `selectForge()` (sage#43 Phase 4) constructs
 * one per CLI invocation or per bus task and threads it through
 * `ReviewOptions`.
 */
export class GitHubBackend implements ForgeBackend {
  readonly kind = "github" as const;

  /**
   * Per-backend-instance review source. Constructed lazily on first
   * read; subsequent `reviewSource()` calls return the same Adapter
   * so the GitHub identity cache inside its closure is shared across
   * the Reviews that use this backend instance.
   */
  private _reviewSource?: ForgeReviewSource;

  parseRef(input: string): PrRef {
    return parsePrRef(input);
  }

  prView(ref: PrRef): Promise<PrMetadata> {
    return prView(ref);
  }

  prDiff(ref: PrRef): Promise<string> {
    return prDiff(ref);
  }

  repoFile(ref: PrRef, path: string, opts?: RepoFileOptions): Promise<string | null> {
    return repoFile(ref, path, opts);
  }

  postReview(input: PostReviewInput): Promise<PostReviewResult> {
    return postReview(input);
  }

  reviewSource(): ForgeReviewSource {
    if (!this._reviewSource) {
      this._reviewSource = createGitHubReviewSource();
    }
    return this._reviewSource;
  }

  authStatus(): Promise<AuthStatusResult> {
    return ghAuthStatus();
  }
}

/** Type re-exports for callers that haven't migrated to `../types.ts` yet. */
export type { PrRef, PrMetadata, ReviewEvent, PostReviewInput, PostReviewResult };
