import { createHash } from "node:crypto";

import type { PrMetadata } from "../forge/types.ts";
import type { BoundedReviewState, DiffCandidate } from "./types.ts";
import type { TypeSafePolicy } from "./policy.ts";

const SECRET_ASSIGNMENT =
  /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b(\s*[:=]\s*)([^\s,;]+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;

export function redactTypeSafeText(value: string): string {
  return value
    .replace(PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) =>
      `${name}${separator}[REDACTED]`,
    );
}

interface RawCandidate {
  path: string;
  startLine: number;
  excerpt: string;
}

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
  const kept: DiffCandidate[] = [];
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
  const retainedChars = kept.reduce((sum, candidate) => sum + candidate.retainedChars, 0);
  return {
    pr: {
      title: redactTypeSafeText(pr.title).slice(0, 500),
      changedPaths: pr.files.map((file) => file.path),
      additions: pr.additions,
      deletions: pr.deletions,
      headSha: pr.headRefOid,
    },
    candidates: kept,
    discardedCandidateSummary: {
      count: discarded.length,
      paths: [...new Set(discarded.map((candidate) => candidate.path))].slice(0, 24),
      reason:
        discarded.length === 0
          ? "none"
          : "candidate count or bounded-state character limit reached",
    },
    truncation: {
      inputChars,
      retainedChars,
      candidatesTruncated,
      stateTruncated: discarded.length > 0 || candidatesTruncated > 0,
    },
  };
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
