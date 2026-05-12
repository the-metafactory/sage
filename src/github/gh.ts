import { spawn } from "node:child_process";

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

export interface PrMetadata {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  author: { login: string };
  changedFiles: number;
  additions: number;
  deletions: number;
  files: ReadonlyArray<{
    path: string;
    additions: number;
    deletions: number;
  }>;
  url: string;
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
  return JSON.parse(out.stdout) as PrMetadata;
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

export async function postReview(input: PostReviewInput): Promise<void> {
  const flag =
    input.event === "approve"
      ? "--approve"
      : input.event === "request-changes"
        ? "--request-changes"
        : "--comment";

  await runGh([
    "pr",
    "review",
    String(input.ref.number),
    "--repo",
    formatRepo(input.ref),
    flag,
    "--body",
    input.body,
  ]);
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

async function runGh(args: string[], opts: { allowNonZero?: boolean } = {}): Promise<RunGhResult> {
  const bin = process.env.GH_BIN ?? "gh";
  return new Promise<RunGhResult>((resolve, reject) => {
    const child = spawn(bin, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0 && !opts.allowNonZero) {
        reject(new Error(`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}
