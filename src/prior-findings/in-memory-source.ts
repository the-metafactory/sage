/**
 * In-memory `ForgeReviewSource` for tests.
 *
 * Lets Module-level tests exercise `createPriorFindings` (trust-gating,
 * dedup, status branches) without spawning `gh` / `glab`. The forge
 * Adapters cover real subprocess + JSON parsing in their own backend
 * test suites.
 */

import type { PrRef } from "../forge/types.ts";
import type { ForgeReviewSource, ForgeReviewSourceResult } from "./types.ts";

export type InMemoryReviewSourceBehavior =
  | { kind: "ok"; result: ForgeReviewSourceResult }
  | { kind: "throw"; error: Error };

export interface InMemoryReviewSourceOptions {
  /** Static return value, or a per-ref function for richer fixtures. */
  behavior: InMemoryReviewSourceBehavior | ((ref: PrRef) => InMemoryReviewSourceBehavior);
}

export function createInMemoryReviewSource(
  opts: InMemoryReviewSourceOptions,
): ForgeReviewSource {
  return {
    async fetchReviewBodies(ref) {
      const b =
        typeof opts.behavior === "function" ? opts.behavior(ref) : opts.behavior;
      if (b.kind === "throw") throw b.error;
      return b.result;
    },
  };
}
