import { encodeDidSegment } from "@the-metafactory/myelin";

/**
 * Sage-local stack-aware subject helpers — IoAW MY-101 Phase A
 * (`specs/namespace.md` §"Stack segment"). Address sage#30: pilot's
 * pending fix (pilot#86) publishes on the canonical 5-segment form, and
 * sage's pre-Phase-A 4-segment subscriptions don't match.
 *
 * **Removal:** once myelin#151 lands stack-aware task / verdict /
 * lifecycle helpers upstream, delete this file and call myelin's
 * `broadcastTaskSubject(org, capability, stack)` etc. directly. The
 * companion `dispatchOperational` adapter in `emissions.ts` follows the
 * same pattern (waiting on myelin#150). Both cleanups consolidate sage's
 * envelope/subject grammar back to a single source of truth.
 *
 * Until then, these helpers wrap myelin's pure-string segment encoder
 * (`encodeDidSegment` from `subjects.ts`) and emit the spec-compliant
 * 5-segment form:
 *
 *   local.{org}.{stack}.tasks.{capability}.{subcapability}      ← broadcast / task
 *   local.{org}.{stack}.tasks.@{principal}.{capability}         ← direct
 *   local.{org}.{stack}.dispatch.task.{state}                   ← lifecycle
 *   local.{org}.{stack}.code.pr.review.{decision}               ← verdict
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

/**
 * Legacy pre-Phase-A subject helpers — kept for the migration window
 * (Holly review on PR#31, major #2). Pilot publishes 4-segment subjects
 * today; after pilot#86 ships, pilot moves to 5-segment. Sage subscribes
 * on BOTH forms via these legacy helpers + the canonical helpers above,
 * so the daemon receives messages from either form during the rollout.
 *
 * **Removal:** drop this block once pilot#86 has shipped + redeployed on
 * Andreas's host. Tracked alongside sage#30 in the PR body's
 * "migration checklist" section.
 */
export function broadcastTaskSubjectLegacy(
  org: string,
  capability: string,
): string {
  assertSegment("org", org);
  assertSegmentPath("capability", capability);
  return `local.${org}.tasks.${capability}.>`;
}

export function directTaskSubjectLegacy(org: string, did: string): string {
  assertSegment("org", org);
  return `local.${org}.tasks.${encodeDidSegment(did)}.>`;
}
