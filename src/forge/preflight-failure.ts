import type { ForgePreflightFailure } from "./types.ts";

const PREFLIGHT_FAILURE_MARKER = "SAGE_PREFLIGHT_FAILURE";

/**
 * The backend's message, then the machine-readable marker as the LAST line, so
 * it survives a caller that keeps only the tail of stderr. The marker's fields
 * are an enum, an integer and a timestamp, so no remote text reaches it.
 */
export function renderPreflightFailure(failure: ForgePreflightFailure): string {
  const marker = JSON.stringify({
    kind: failure.kind,
    ...(failure.httpStatus !== undefined ? { http_status: failure.httpStatus } : {}),
    ...(failure.resetAt !== undefined ? { reset_at: failure.resetAt } : {}),
  });
  return `${failure.message}\n${PREFLIGHT_FAILURE_MARKER} ${marker}`;
}
