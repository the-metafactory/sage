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
 */

const STACK_SEGMENT_REGEX = /^[a-z][a-z0-9-]{0,62}$/;

/** Default stack name per IoAW Q7 — single-stack operators use this. */
export const DEFAULT_STACK = "default";

/**
 * Validate a stack segment against the canonical regex from
 * `myelin/specs/namespace.md`. Throws with the operator-facing detail when
 * invalid so a misconfigured `SAGE_STACK` env value fails near startup.
 */
export function validateStack(stack: string): string {
  if (!STACK_SEGMENT_REGEX.test(stack)) {
    throw new Error(
      `stack segment "${stack}" must match ${STACK_SEGMENT_REGEX.source} ` +
        `(lowercase alphanumeric + hyphens, 1-63 chars, starts with letter)`,
    );
  }
  return stack;
}

export function broadcastTaskSubject(
  org: string,
  stack: string,
  capability: string,
): string {
  return `local.${org}.${stack}.tasks.${capability}.>`;
}

export function directTaskSubject(
  org: string,
  stack: string,
  did: string,
): string {
  return `local.${org}.${stack}.tasks.${encodeDidSegment(did)}.>`;
}

export function taskSubject(
  org: string,
  stack: string,
  capability: string,
): string {
  return `local.${org}.${stack}.tasks.${capability}`;
}

export function verdictSubject(
  org: string,
  stack: string,
  family: string,
  status: string,
): string {
  return `local.${org}.${stack}.code.pr.${family}.${status}`;
}

export function verdictWildcard(
  org: string,
  stack: string,
  family: string,
): string {
  return `local.${org}.${stack}.code.pr.${family}.>`;
}

export function deriveLifecycleSubject(
  org: string,
  stack: string,
  state: string,
): string {
  return `local.${org}.${stack}.dispatch.task.${state}`;
}

export function deriveLifecycleWildcard(org: string, stack: string): string {
  return `local.${org}.${stack}.dispatch.task.>`;
}
