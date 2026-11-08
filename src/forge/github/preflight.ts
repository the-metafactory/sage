import { isTransientNetworkError } from "../../util/retry.ts";
import type { ForgePreflightFailure } from "../types.ts";

/**
 * `GET /` rather than `GET /user`: it is the call `gh auth status` makes, so
 * a token that lacks `/user` access (a GitHub App installation token) keeps
 * passing. `-i` is what keeps the status and headers `gh auth status` discards.
 */
export const GH_PREFLIGHT_ARGS = ["api", "/", "-i"];

/** From `gh help exit-codes`: "If a command requires authentication". */
const GH_AUTH_REQUIRED_EXIT = 4;

const RATE_LIMIT_MESSAGE = /rate limit|abuse detection/i;
const NETWORK_FAILURE_GO_TEXT = /timed out|i\/o timeout|handshake timeout|no such host|\bEOF\b/i;
const DETAIL_MAX_CHARS = 300;

export interface GhApiOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type ClassifiedFailure = Omit<ForgePreflightFailure, "message"> & { detail: string };

interface GhApiResponse {
  status: number;
  headers: Map<string, string>;
  message: string;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX_CHARS);
}

function responseMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch (_notJson) {
    return body;
  }
  return body;
}

function parseResponse(stdout: string): GhApiResponse | undefined {
  const [statusLine = "", ...rest] = stdout.split("\n");
  const statusMatch = /^HTTP\/\S+ (\d{3})\b ?(.*)$/.exec(statusLine.trim());
  if (!statusMatch) return undefined;
  const blank = rest.findIndex((line) => line.trim() === "");
  const headerLines = blank === -1 ? rest : rest.slice(0, blank);
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const body = blank === -1 ? "" : rest.slice(blank + 1).join("\n").trim();
  return {
    status: Number(statusMatch[1]),
    headers,
    message: responseMessage(body) || (statusMatch[2] ?? ""),
  };
}

function isRateLimited({ status, headers, message }: GhApiResponse): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return (
    headers.has("retry-after") ||
    headers.get("x-ratelimit-remaining") === "0" ||
    RATE_LIMIT_MESSAGE.test(message)
  );
}

function wholeSeconds(raw: string | undefined): number | undefined {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * A secondary-limit 403 also carries `x-ratelimit-reset`, but that is the core
 * budget's reset and says nothing about when the refusal ends; it applies only
 * when that budget is the one exhausted.
 */
function rateLimitResetAt(headers: Map<string, string>, nowMs: number): string | undefined {
  const retryAfter = wholeSeconds(headers.get("retry-after"));
  if (retryAfter !== undefined) return new Date(nowMs + retryAfter * 1000).toISOString();
  if (headers.get("x-ratelimit-remaining") !== "0") return undefined;
  const reset = wholeSeconds(headers.get("x-ratelimit-reset"));
  return reset === undefined ? undefined : new Date(reset * 1000).toISOString();
}

function classifyResponse(response: GhApiResponse, nowMs: number): ClassifiedFailure {
  const { status, headers, message } = response;
  const detail = singleLine(`HTTP ${status}: ${message}`);
  if (status === 401) return { kind: "auth", httpStatus: status, detail };
  if (isRateLimited(response)) {
    const resetAt = rateLimitResetAt(headers, nowMs);
    return { kind: "rate-limit", httpStatus: status, detail, ...(resetAt ? { resetAt } : {}) };
  }
  if (status >= 500) return { kind: "transient", httpStatus: status, detail };
  return { kind: "unknown", httpStatus: status, detail };
}

function classifyWithoutResponse({ exitCode, stdout, stderr }: GhApiOutcome): ClassifiedFailure {
  const text = stderr.trim() || stdout.trim();
  const detail = singleLine(text) || `gh exited ${exitCode} with no output`;
  if (exitCode === GH_AUTH_REQUIRED_EXIT) return { kind: "auth", detail };
  if (isTransientNetworkError(text) || NETWORK_FAILURE_GO_TEXT.test(text)) return { kind: "transient", detail };
  return { kind: "unknown", detail };
}

function humanMessage({ kind, detail, resetAt }: ClassifiedFailure): string {
  switch (kind) {
    case "auth":
      return `gh auth is not configured. Run \`gh auth login\` first.\n${detail}`;
    case "rate-limit":
      return `GitHub rate limit refused the preflight (${detail}). ${resetAt ? `Retry after ${resetAt}.` : "GitHub gave no reset time."}`;
    case "transient":
      return `Transient GitHub failure in the preflight (${detail}). Retry later.`;
    case "unknown":
      return `GitHub preflight failed (${detail}).`;
  }
}

/** Classify a failed `gh api` from the failed response itself, never from a second request. */
export function classifyGhApiFailure(outcome: GhApiOutcome, nowMs: number = Date.now()): ForgePreflightFailure {
  const response = parseResponse(outcome.stdout);
  const classified = response ? classifyResponse(response, nowMs) : classifyWithoutResponse(outcome);
  const { detail: _detail, ...signal } = classified;
  return { ...signal, message: humanMessage(classified) };
}
