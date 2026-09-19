import type { PrMetadata, PrRef } from "../forge/types.ts";
import type { Verdict } from "../verdict/types.ts";
import type { LensReport } from "./types.ts";

/** Immutable snapshot emitted after Sage has completed its authoritative work. */
export interface CompletedReviewObservation {
  readonly ref: Readonly<PrRef>;
  readonly pr: Readonly<PrMetadata>;
  readonly diff: string;
  readonly selectedLensNames: readonly string[];
  readonly lensReports: readonly Readonly<LensReport>[];
  readonly verdict: Readonly<Verdict>;
  readonly posted: boolean;
}

export interface CompletedReviewAnchor {
  readonly ref: Readonly<PrRef>;
  readonly headSha: string;
}

/** Implementation-neutral, fail-open port for advisory work after a completed Review. */
export interface CompletedReviewObserver {
  accepts?(anchor: CompletedReviewAnchor): boolean;
  observe(input: CompletedReviewObservation): Promise<void>;
}
