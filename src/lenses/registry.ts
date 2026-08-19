import { reviewCodeQuality } from "./code-quality.ts";
import { reviewSecurity } from "./security.ts";
import { reviewArchitecture } from "./architecture.ts";
import { reviewContextDrift } from "./context-drift.ts";
import { reviewEcosystemCompliance } from "./ecosystem-compliance.ts";
import { reviewPerformance } from "./performance.ts";
import { reviewMaintainability } from "./maintainability.ts";
import { reviewHonestOracle } from "./honest-oracle.ts";
import { reviewFederationGrammar } from "./federation-grammar.ts";
import {
  securityApplies,
  architectureApplies,
  contextDriftApplies,
  ecosystemComplianceApplies,
  performanceApplies,
  maintainabilityApplies,
  honestOracleApplies,
  federationGrammarApplies,
  type ApplicabilityContext,
} from "./applicability.ts";
import type { LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

/**
 * Declarative lens registry. Each entry self-describes its name, runner,
 * and optional applicability predicate. `workflow.ts` iterates this
 * registry in declared order rather than hardcoding per-lens imports +
 * if-blocks.
 *
 * Adding a simple lens = append one entry here + a new lens file under
 * src/lenses/. Lenses that need shared preloaded context may also extend
 * workflow/base input plumbing. The compiler enforces the `LensModule`
 * shape so an entry with a missing runner or an applicability predicate
 * of the wrong type fails to typecheck.
 */
/**
 * How much of the change a Lens needs in order to judge it (sage#107).
 *
 *   - `cumulative` — the whole PR diff. The default, and the only correct
 *     answer for a Lens whose judgement is about the change AS A WHOLE:
 *     duplication, module boundaries, file size. Narrowing those to the last
 *     round's delta does not make them cheaper, it makes them wrong.
 *   - `delta` — only what changed since Sage's previous review of this PR.
 *     Correct for a Lens that judges lines locally, and the reason a round-12
 *     review costs a fraction of a round-1 review instead of the same amount.
 *
 * A Lens declaring `delta` still falls back to the cumulative diff whenever
 * there is no previous Sage review, or the Forge cannot produce the comparison
 * — reviewing more than necessary is the safe direction.
 */
export type LensReviewScope = "delta" | "cumulative";

export interface LensModule {
  /** Display name (also returned in LensReport.lens). */
  name: string;
  /** Per-PR lens runner. */
  review: (input: LensRunInput) => Promise<LensReport>;
  /**
   * Optional applicability predicate. Returns true when the lens should
   * fire for the given PR. Omitting `applies` means "always fire" — used
   * by the CodeQuality lens.
   */
  applies?: (ctx: ApplicabilityContext) => boolean;
  /**
   * Preload target-repo architecture/context docs for this lens.
   * The scheduler passes those docs only to opted-in lens runners.
   */
  usesArchitectureDocs?: boolean | ((ctx: ApplicabilityContext) => boolean);
  /**
   * How much of the change this Lens needs. Omitted means `cumulative`, so a
   * Lens added later gets the whole picture until someone decides otherwise.
   */
  reviewScope?: LensReviewScope;
  /**
   * True for the Lens whose subject is the PR's CLAIMS rather than its code.
   * The workflow records a digest of what such a Lens checked, so the next
   * Review can ask whether the claims are new instead of re-reading them every
   * round (sage#107).
   */
  checksClaims?: boolean;
}

/** A Lens's declared review scope, defaulting to the safe `cumulative`. */
export function lensReviewScope(lens: LensModule): LensReviewScope {
  return lens.reviewScope ?? "cumulative";
}

export function lensUsesArchitectureDocs(
  lens: LensModule,
  ctx: ApplicabilityContext,
): boolean {
  if (typeof lens.usesArchitectureDocs === "function") {
    return lens.usesArchitectureDocs(ctx);
  }
  return lens.usesArchitectureDocs === true;
}

/**
 * Canonical lens order: CodeQuality first (always fires), then the
 * conditional lenses gated on their applicability predicates. The original
 * five-lens shape came from cortex/docs/design-pi-dev-review-agent.md §7;
 * Sage-local lenses extend that order here.
 *
 * Maintainability is ordered last so its findings (duplication, function
 * size, complexity) read after the substantive correctness / security /
 * shape passes — readers process "is this wrong?" before "is this hard to
 * change?". Its applicability gate is broader than the others (most non-
 * trivial code PRs benefit) but still skips docs/lock/config-only diffs.
 */
export const LENSES: readonly LensModule[] = [
  { name: "CodeQuality", review: reviewCodeQuality, reviewScope: "delta" },
  { name: "Security", review: reviewSecurity, applies: securityApplies, reviewScope: "delta" },
  {
    name: "Architecture",
    review: reviewArchitecture,
    applies: architectureApplies,
    usesArchitectureDocs: true,
  },
  {
    name: "ContextDrift",
    review: reviewContextDrift,
    applies: contextDriftApplies,
    usesArchitectureDocs: true,
    reviewScope: "delta",
  },
  {
    name: "EcosystemCompliance",
    review: reviewEcosystemCompliance,
    applies: ecosystemComplianceApplies,
    reviewScope: "delta",
  },
  {
    name: "Performance",
    review: reviewPerformance,
    applies: performanceApplies,
    reviewScope: "delta",
  },
  // Maintainability stays `cumulative` (the default): duplication and file size
  // are properties of the whole change. A delta-scoped Maintainability lens
  // would report "no duplication" on a round that added the second copy.
  {
    name: "Maintainability",
    review: reviewMaintainability,
    applies: maintainabilityApplies,
  },
  // The adversarial lens runs last — after the constructive passes have said
  // what the code IS, the Oracle asks whether the PR's claims about it hold.
  // Kept a distinct lens (never merged with a fixer) so it can't pull punches.
  // Stays `cumulative`: the Oracle weighs the PR description's claims against
  // the artifact, and the artifact is the whole change, not the last round of
  // it. Its wording findings are no longer merge-blocking anyway (sage#107).
  {
    name: "HonestOracle",
    review: reviewHonestOracle,
    applies: honestOracleApplies,
    checksClaims: true,
  },
  // FederationGrammar ports compass sops/federation-wire-protocol.md checks
  // 1-5 (compass#99 F8) — there is no skill file for this, the SOP itself
  // is the authoritative source. Fires only on federated.*-touching diffs
  // (federationGrammarApplies); needs CONTEXT.md/CONTEXT-MAP.md for
  // §Network/§Dispatch terminology grounding.
  {
    name: "FederationGrammar",
    review: reviewFederationGrammar,
    applies: federationGrammarApplies,
    usesArchitectureDocs: true,
    reviewScope: "delta",
  },
];
