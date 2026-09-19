import { createHash } from "node:crypto";

import type { PrMetadata } from "../forge/types.ts";
import type { BoundedReviewState, DiffCandidate } from "./types.ts";
import type { TypeSafePolicy } from "./policy.ts";

const SECRET_ASSIGNMENT =
  /(["']?)((?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|(?:api|access|private|secret|signing)[_-]?key)|(?:database|redis|mongodb|amqp)[_-]?(?:url|uri)|connection[_-]?string)\1(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;
const YAML_SECRET_BLOCK =
  /^(\s*["']?(?:(?:[a-z0-9]+[_-])*(?:password|passwd|secret|token|(?:api|access|private|secret|signing)[_-]?key)|(?:database|redis|mongodb|amqp)[_-]?(?:url|uri)|connection[_-]?string)["']?\s*:\s*[>|][-+]?\s*)\n(?:[ \t]+.*(?:\n|$))+/gim;
const CREDENTIAL_URI = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTHORIZATION_CREDENTIAL =
  /\b(Authorization\s*:\s*(?:Basic|Digest|Token|ApiKey)\s+)[^\s,;]+/gi;
const CURL_USER = /(\bcurl\b[^\r\n]*?\s-u\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;
const RESIDUAL_AUTHORIZATION_LINE = /^.*\bAuthorization\s*:.*$/gim;
const RESIDUAL_CURL_CREDENTIAL_LINE = /^.*\bcurl\b.*(?:--user|-u)\s+.*$/gim;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const PROVIDER_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,})\b/g;

export function redactTypeSafeText(value: string): string {
  return value
    .replace(PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
    .replace(YAML_SECRET_BLOCK, "$1\n  [REDACTED]\n")
    .replace(CREDENTIAL_URI, "$1[REDACTED]@")
    .replace(AUTHORIZATION_CREDENTIAL, "$1[REDACTED]")
    .replace(CURL_USER, "$1[REDACTED]")
    .replace(RESIDUAL_AUTHORIZATION_LINE, "[REDACTED_AUTHORIZATION_LINE]")
    .replace(RESIDUAL_CURL_CREDENTIAL_LINE, "[REDACTED_CURL_CREDENTIAL_LINE]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(PROVIDER_TOKEN, "[REDACTED_TOKEN]")
    .replace(SECRET_ASSIGNMENT, (_match, quote: string, name: string, separator: string) =>
      `${quote}${name}${quote}${separator}[REDACTED]`,
    );
}

interface RawCandidate {
  path: string;
  startLine: number;
  excerpt: string;
}

type MutableDiffCandidate = { -readonly [K in keyof DiffCandidate]: DiffCandidate[K] };

function parseDiffCandidates(diff: string): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  let path = "(unknown)";
  let startLine = 0;
  let lines: string[] = [];

  const flush = (): void => {
    if (lines.length === 0) return;
    candidates.push({ path, startLine, excerpt: lines.join("\n") });
    lines = [];
  };

  for (const line of diff.split("\n")) {
    const file = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (file) {
      flush();
      path = file[2]!;
      startLine = 0;
      continue;
    }
    const hunk = line.match(/^@@ [^+]*\+(\d+)/);
    if (hunk) {
      flush();
      startLine = Number(hunk[1]);
      lines.push(line);
      continue;
    }
    if (lines.length > 0) lines.push(line);
  }
  flush();
  return candidates;
}

function candidateReason(path: string): string {
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\./i.test(path)) {
    return "changed test retained for test-gap and deceptive-test context";
  }
  return "changed source hunk retained in deterministic diff order";
}

export function buildBoundedReviewState(
  pr: Readonly<PrMetadata>,
  diff: string,
  policy: TypeSafePolicy,
): BoundedReviewState {
  const inputChars = diff.length;
  const raw = parseDiffCandidates(diff);
  const kept: MutableDiffCandidate[] = [];
  let remaining = policy.bounds.maxStateChars;
  let candidatesTruncated = 0;

  for (const [index, candidate] of raw.entries()) {
    if (kept.length >= policy.bounds.maxCandidates || remaining <= 0) break;
    const redacted = redactTypeSafeText(candidate.excerpt);
    const cap = Math.min(policy.bounds.maxCandidateChars, remaining);
    const excerpt = redacted.slice(0, cap);
    const truncated = excerpt.length < redacted.length;
    if (truncated) candidatesTruncated++;
    kept.push({
      id: `candidate_${index + 1}`,
      path: candidate.path,
      startLine: candidate.startLine,
      excerpt,
      selectionReason: candidateReason(candidate.path),
      originalChars: candidate.excerpt.length,
      retainedChars: excerpt.length,
      truncated,
    });
    remaining -= excerpt.length;
  }

  const discarded = raw.slice(kept.length);
  let removedCandidates = 0;
  let metadataTruncated = false;
  const state = {
    pr: {
      title: redactTypeSafeText(pr.title).slice(0, 500),
      changedPaths: pr.files.map((file) => redactTypeSafeText(file.path)),
      additions: pr.additions,
      deletions: pr.deletions,
      headSha: pr.headRefOid,
    },
    candidates: kept,
    discardedCandidateSummary: {
      count: discarded.length,
      paths: [...new Set(discarded.map((candidate) => redactTypeSafeText(candidate.path)))].slice(0, 24),
      reason:
        discarded.length === 0
          ? "none"
          : "candidate count or bounded-state character limit reached",
    },
    truncation: {
      inputChars,
      retainedChars: kept.reduce((sum, candidate) => sum + candidate.retainedChars, 0),
      candidatesTruncated,
      stateTruncated: discarded.length > 0 || candidatesTruncated > 0,
    },
  };

  // maxStateChars is a bound on the complete serialized request state, not
  // merely the sum of excerpts. Trim data fields deterministically until the
  // actual JSON payload fits; fixed counters and fingerprints remain intact.
  let serializedLength = JSON.stringify(state).length;
  while (serializedLength > policy.bounds.maxStateChars) {
    const excess = serializedLength - policy.bounds.maxStateChars;
    const candidate = [...state.candidates].reverse().find((item) => item.excerpt.length > 0);
    if (candidate) {
      const cut = Math.min(candidate.excerpt.length, Math.max(1, excess));
      candidate.excerpt = candidate.excerpt.slice(0, candidate.excerpt.length - cut);
      candidate.retainedChars = candidate.excerpt.length;
      candidate.truncated = true;
      serializedLength = JSON.stringify(state).length;
      continue;
    }
    if (state.candidates.length > 0) {
      state.candidates.pop();
      state.discardedCandidateSummary.count++;
      removedCandidates++;
      metadataTruncated = true;
      serializedLength = JSON.stringify(state).length;
      continue;
    }
    if (state.discardedCandidateSummary.paths.length > 0) {
      let removedChars = 0;
      while (state.discardedCandidateSummary.paths.length > 0 && removedChars < excess) {
        removedChars += state.discardedCandidateSummary.paths.pop()!.length + 3;
      }
      metadataTruncated = true;
      serializedLength = JSON.stringify(state).length;
      continue;
    }
    if (state.pr.changedPaths.length > 0) {
      let removedChars = 0;
      while (state.pr.changedPaths.length > 0 && removedChars < excess) {
        removedChars += state.pr.changedPaths.pop()!.length + 3;
      }
      metadataTruncated = true;
      serializedLength = JSON.stringify(state).length;
      continue;
    }
    if (state.pr.title.length > 0) {
      state.pr.title = state.pr.title.slice(0, Math.max(0, state.pr.title.length - Math.max(1, excess)));
      metadataTruncated = true;
      serializedLength = JSON.stringify(state).length;
      continue;
    }
    throw new Error("TypeSafe maxStateChars is too small for the fixed bounded-state schema");
  }

  state.truncation.retainedChars = state.candidates.reduce(
    (sum, candidate) => sum + candidate.retainedChars,
    0,
  );
  state.truncation.candidatesTruncated =
    removedCandidates + state.candidates.filter((candidate) => candidate.truncated).length;
  state.truncation.stateTruncated ||= metadataTruncated;
  return state;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
