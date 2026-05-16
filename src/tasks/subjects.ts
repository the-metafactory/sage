import { encodeDidSegment } from "@the-metafactory/myelin";

/**
 * Sage-local stack-aware subject helpers — IoAW MY-101 Phase A
 * (`specs/namespace.md` §"Stack segment"). Addresses sage#30: pilot's
 * fix (pilot#110, merged) publishes on the canonical 6-segment
 * stack-aware form, and sage's pre-Phase-A 4-segment subscriptions
 * didn't match. These helpers close that gap on the subscribe side.
 *
 * **Removal:** myelin#152 (merged) extended `taskSubject` and
 * `broadcastTaskSubject` to accept `stack`; myelin#154 (in flight)
 * extends the same to `verdictSubject`, `verdictWildcard`,
 * `directTaskSubject`, `deriveLifecycleSubject`, and
 * `deriveLifecycleWildcard`. Once #154 ships, delete this file and call
 * myelin's helpers directly. The companion `dispatchOperational`
 * adapter in `emissions.ts` follows the same pattern. Both cleanups
 * consolidate sage's envelope/subject grammar back to a single source
 * of truth in myelin.
 *
 * Until then, these helpers wrap myelin's pure-string segment encoder
 * (`encodeDidSegment` from `subjects.ts`) and emit the spec-compliant
 * **6-segment stack-aware form** (7 segments for the verdict shape,
 * which carries `{family}.{status}` as a two-segment tail):
 *
 *   local.{org}.{stack}.tasks.{capability}.{subcapability}      ← broadcast / task
 *   local.{org}.{stack}.tasks.@{principal}.{capability}         ← direct
 *   local.{org}.{stack}.dispatch.task.{state}                   ← lifecycle
 *   local.{org}.{stack}.code.pr.{family}.{status}               ← verdict (7 segments)
 *
 * Sage's `default` operator runs with `stack = "default"` per IoAW Q7;
 * multi-stack operators set `SAGE_STACK` to override.
 *
 * **Segment validation (Holly review on PR#31):** every segment that
 * lands in the wire format goes through `assertSegment` /
 * `assertSegmentPath` before string interpolation. Mirrors what myelin's
 * helpers used to do for us — operator misconfig (e.g. `SAGE_ORG="foo*"`)
 * fails near startup with a specific error rather than producing a
 * subject that NATS interprets as a wildcard.
 */

const STACK_SEGMENT_REGEX = /^[a-z][a-z0-9-]{0,62}$/;

/** Default stack name per IoAW Q7 — single-stack operators use this. */
export const DEFAULT_STACK = "default";

/**
 * Validate a single namespace segment against the canonical regex from
 * `myelin/specs/namespace.md`. Throws with the operator-facing detail
 * when invalid.
 */
function assertSegment(field: string, value: string): void {
  if (!STACK_SEGMENT_REGEX.test(value)) {
    throw new Error(
      `Invalid ${field} segment "${value}": must match ${STACK_SEGMENT_REGEX.source} ` +
        `(lowercase alphanumeric + hyphens, 1-63 chars, starts with letter)`,
    );
  }
}

/**
 * Validate a dot-separated namespace path: every token between dots
 * must independently match the segment regex. Used for `capability`
 * values like `"code-review.typescript"`.
 */
function assertSegmentPath(field: string, value: string): void {
  if (value === "") {
    throw new Error(`Invalid ${field} path "${value}": must be non-empty`);
  }
  for (const tok of value.split(".")) {
    if (!STACK_SEGMENT_REGEX.test(tok)) {
      throw new Error(
        `Invalid ${field} path "${value}": token "${tok}" must match ${STACK_SEGMENT_REGEX.source}`,
      );
    }
  }
}

/**
 * Validate a stack segment. Public so the bridge / dispatcher can fail
 * near startup on a malformed `SAGE_STACK` env value (instead of
 * surfacing the failure on the first publish attempt).
 */
export function validateStack(stack: string): string {
  assertSegment("stack", stack);
  return stack;
}

export function broadcastTaskSubject(
  org: string,
  stack: string,
  capability: string,
): string {
  assertSegment("org", org);
  assertSegment("stack", stack);
  assertSegmentPath("capability", capability);
  return `local.${org}.${stack}.tasks.${capability}.>`;
}

export function directTaskSubject(
  org: string,
  stack: string,
  did: string,
): string {
  assertSegment("org", org);
  assertSegment("stack", stack);
  // `encodeDidSegment` validates the DID shape upstream — re-validate
  // shape would be redundant.
  return `local.${org}.${stack}.tasks.${encodeDidSegment(did)}.>`;
}

export function taskSubject(
  org: string,
  stack: string,
  capability: string,
): string {
  assertSegment("org", org);
  assertSegment("stack", stack);
  assertSegmentPath("capability", capability);
  return `local.${org}.${stack}.tasks.${capability}`;
}

export function verdictSubject(
  org: string,
  stack: string,
  family: string,
  status: string,
): string {
  assertSegment("org", org);
  assertSegment("stack", stack);
  assertSegment("family", family);
  assertSegment("status", status);
  return `local.${org}.${stack}.code.pr.${family}.${status}`;
}

export function verdictWildcard(
  org: string,
  stack: string,
  family: string,
): string {
  assertSegment("org", org);
  assertSegment("stack", stack);
  assertSegment("family", family);
  return `local.${org}.${stack}.code.pr.${family}.>`;
}

export function deriveLifecycleSubject(
  org: string,
  stack: string,
  state: string,
): string {
  assertSegment("org", org);
  assertSegment("stack", stack);
  assertSegment("state", state);
  return `local.${org}.${stack}.dispatch.task.${state}`;
}

export function deriveLifecycleWildcard(org: string, stack: string): string {
  assertSegment("org", org);
  assertSegment("stack", stack);
  return `local.${org}.${stack}.dispatch.task.>`;
}
