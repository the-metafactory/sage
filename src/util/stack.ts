import { STACK_SEGMENT_REGEX } from "@the-metafactory/myelin";

/**
 * Default operator stack identifier per IoAW Q7 — operators that don't
 * set `SAGE_STACK` (or pass `stack` explicitly) land here. The myelin
 * grammar accepts a 6-segment subject with `default` slotted between
 * `{org}` and `{domain}`, and the backward-compat rule
 * (`myelin/specs/namespace.md:88`) maps legacy 5-segment publishers to
 * this stack.
 */
export const DEFAULT_STACK = "default";

/**
 * Resolve and validate an optional stack identifier near startup, so
 * a malformed `SAGE_STACK` env value fails with a specific error on
 * the boot path rather than surfacing on the first publish attempt.
 *
 * Validation delegates to myelin's `STACK_SEGMENT_REGEX` — the same
 * regex its subject helpers apply internally. Calling this at startup
 * is a redundant fail-fast, not the only validation gate.
 */
export function resolveStack(stack: string | undefined): string {
  const resolved = stack ?? DEFAULT_STACK;
  if (!STACK_SEGMENT_REGEX.test(resolved)) {
    throw new Error(
      `Invalid stack segment "${resolved}": must match ${STACK_SEGMENT_REGEX.source} ` +
        `(lowercase alphanumeric + hyphens, 1-63 chars, starts with letter)`,
    );
  }
  return resolved;
}
