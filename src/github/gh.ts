import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { buildGhEnv } from "./env.ts";
import { retryTransient } from "../util/retry.ts";

/**
 * gh CLI wrapper. Piggybacks on the user's existing `gh auth` login — no token
 * juggling, no Octokit. Read-only by default; the `review` op posts comments
 * via `gh pr review`, scoped to comment events only.
 */

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

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

/**
 * Runtime shape validation for `gh pr view --json` output. Localizes a
 * schema-drift failure to this wrapper rather than letting a TypeError
 * surface deep in the lens pipeline.
 */
export const PrMetadataSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().transform((s) => s ?? ""),
  state: z.string(),
  isDraft: z.boolean(),
  baseRefName: z.string(),
  headRefName: z.string(),
  author: z.object({ login: z.string() }),
  changedFiles: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  files: z
    .array(
      z.object({
        path: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    )
    .default([]),
  url: z.string().url(),
});

export type PrMetadata = z.infer<typeof PrMetadataSchema>;

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

export type ReviewEvent = "comment" | "approve" | "request-changes";

export interface PostReviewInput {
  ref: PrRef;
  event: ReviewEvent;
  body: string;
}

export interface PostReviewResult {
  /** Event actually accepted by GitHub. May be downgraded from input.event. */
  posted: ReviewEvent;
  /** True when GH blocked self-{approve,request-changes} and we fell back. */
  downgraded: boolean;
}

/**
 * GraphQL error family GH returns when the authenticated user equals the PR
 * author and tries to approve/request-changes their own PR. Matches both
 * "approve" and "request changes" wording; the `--comment` event is always
 * allowed and never produces this error.
 */
export const SELF_REVIEW_BLOCK_RE =
  /Can not (?:approve|request changes on) your own pull request/i;

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

export async function ghAuthStatus(): Promise<{ ok: boolean; output: string }> {
  try {
    const out = await runGh(["auth", "status"], { allowNonZero: true });
    return { ok: out.exitCode === 0, output: out.stdout + out.stderr };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg };
  }
}

interface RunGhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_GH_TIMEOUT_MS = 30_000;

async function runGh(
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
