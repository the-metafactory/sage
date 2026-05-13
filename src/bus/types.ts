/**
 * Shared bus-domain types. Re-exported from envelope.ts / subjects.ts /
 * dispatcher.ts / bridge.ts callers — gives a single import surface and
 * prevents the type from drifting between modules.
 */

/** Identity context used by subject-derivation helpers. */
export interface SubjectConfig {
  /** Org segment (e.g., "metafactory"). */
  org: string;
  /** DID of the agent (e.g., "did:mf:sage"). */
  did: string;
}
