import { reviewCodeQuality } from "./code-quality.ts";
import { reviewSecurity } from "./security.ts";
import { reviewArchitecture } from "./architecture.ts";
import { reviewEcosystemCompliance } from "./ecosystem-compliance.ts";
import { reviewPerformance } from "./performance.ts";
import { reviewMaintainability } from "./maintainability.ts";
import {
  securityApplies,
  architectureApplies,
  ecosystemComplianceApplies,
  performanceApplies,
  maintainabilityApplies,
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
 * Adding lens #6 = append one entry here + a new lens file under
 * src/lenses/. No edits to workflow.ts. The compiler enforces the
 * `LensModule` shape so an entry with a missing runner or an
 * applicability predicate of the wrong type fails to typecheck.
 */
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
}

/**
 * Canonical lens order: CodeQuality first (always fires), then five
 * conditional lenses gated on their applicability predicates. Per
 * cortex/docs/design-pi-dev-review-agent.md §7.
 *
 * Maintainability is ordered last so its findings (duplication, function
 * size, complexity) read after the substantive correctness / security /
 * shape passes — readers process "is this wrong?" before "is this hard to
 * change?". Its applicability gate is broader than the others (most non-
 * trivial code PRs benefit) but still skips docs/lock/config-only diffs.
 */
export const LENSES: readonly LensModule[] = [
  { name: "CodeQuality", review: reviewCodeQuality },
  { name: "Security", review: reviewSecurity, applies: securityApplies },
  { name: "Architecture", review: reviewArchitecture, applies: architectureApplies },
  {
    name: "EcosystemCompliance",
    review: reviewEcosystemCompliance,
    applies: ecosystemComplianceApplies,
  },
  { name: "Performance", review: reviewPerformance, applies: performanceApplies },
  {
    name: "Maintainability",
    review: reviewMaintainability,
    applies: maintainabilityApplies,
  },
];
