/**
 * Top-level PR/MR ref parser. Routes a user-supplied string to the
 * GitHub or GitLab parser by URL pattern, then by shorthand
 * separator (`#` → GitHub, `!` → GitLab). Returns a tagged `PrRef`
 * with `kind` set so downstream code can route on the discriminator
 * without re-parsing.
 *
 * Sage CLI + bus dispatcher both go through this function so they
 * accept either forge's input shape transparently. Per-backend
 * `parsePrRef` exports remain for the backends' own use and for
 * tests, but external callers should prefer this top-level entry.
 */

import { parsePrRef as parseGithubRef } from "./github/backend.ts";
import { parsePrRef as parseGitlabRef } from "./gitlab/backend.ts";
import type { ForgeKind, PrRef } from "./types.ts";

const GITHUB_URL_RE = /^https?:\/\/github\.com\//i;
const GITLAB_URL_RE = /^https?:\/\/[^/]*gitlab[^/]*\//i;
// Anything with `/-/merge_requests/` is GitLab regardless of hostname,
// to support self-hosted instances whose domain doesn't contain
// "gitlab". Hostname-based detection above is a fast path for the
// common cases (gitlab.com, gitlab.example.com).
const GITLAB_MR_PATH_RE = /\/-\/merge_requests\//;
const GITHUB_PULL_PATH_RE = /\/pull\//;

export function detectForgeKindFromRef(input: string): ForgeKind | null {
  const trimmed = input.trim();
  if (GITHUB_URL_RE.test(trimmed)) return "github";
  if (GITLAB_URL_RE.test(trimmed)) return "gitlab";
  if (GITLAB_MR_PATH_RE.test(trimmed)) return "gitlab";
  if (GITHUB_PULL_PATH_RE.test(trimmed)) return "github";
  // Shorthand separator: `#` is GitHub, `!` is GitLab. The shorthand
  // forms (OWNER/REPO#N, GROUP/PROJ!N) are unambiguous by separator.
  if (/#\d+\b/.test(trimmed)) return "github";
  if (/![0-9]+\b/.test(trimmed)) return "gitlab";
  return null;
}

/**
 * Parse a PR/MR ref string, routing to the right per-forge parser.
 * Throws if neither forge claims the input.
 */
export function parsePrRef(input: string, hint?: ForgeKind): PrRef {
  const kind = hint ?? detectForgeKindFromRef(input);
  if (kind === "gitlab") return parseGitlabRef(input);
  if (kind === "github") return parseGithubRef(input);
  throw new Error(
    `unrecognized PR/MR reference: "${input}" — expected a GitHub (OWNER/REPO#N, https://github.com/.../pull/N) or GitLab (GROUP/PROJ!N, https://HOST/.../-/merge_requests/N) form`,
  );
}
