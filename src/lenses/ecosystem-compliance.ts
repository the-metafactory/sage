import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

const FOCUS = `Look at this PR through a metafactory-ecosystem compliance lens. You care
about: arc-manifest.yaml conformance (matches arc's schema; capabilities
declared honestly), Myelin envelope conformance (sovereignty fields present;
subject prefix matches classification), cortex agent fragment shape (id /
roles / trust / runtime block well-formed), claude-code hook + skill format
(SKILL.md frontmatter, hook event registration), PAI conventions (single
persona file per agent, no parallel acceptance artifacts), and lifecycle
script ordering (preinstall/postinstall sequences match the documented
contract). You do NOT look for code style, security, or performance — those
belong to other lenses.

Flag a finding when the change diverges from a documented ecosystem
contract (referenced design doc, schema, or convention).`;

export async function reviewEcosystemCompliance(input: LensRunInput): Promise<LensReport> {
  return runLens({ name: "EcosystemCompliance", focus: FOCUS }, input);
}
