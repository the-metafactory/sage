import type { PrMetadata } from "../github/gh.ts";

/**
 * Trigger heuristics for the conditional lenses (Security, Architecture,
 * EcosystemCompliance, Performance) per cortex/docs/design-pi-dev-review-agent.md
 * §7. CodeQuality always fires; the others run only when the PR is in scope.
 *
 * Each predicate is intentionally cheap (file paths + a quick diff regex
 * scan) so the workflow can decide which lenses to dispatch without paying
 * a model call.
 */

export interface ApplicabilityContext {
  pr: PrMetadata;
  diff: string;
}

// ──────────────────────────── Security ────────────────────────────

const SECURITY_PATH_PATTERNS = [
  /\bauth\b/i,
  /\blogin\b/i,
  /\btoken\b/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\bcred(?:ential|s)?\b/i,
  /\.env(?:\.|$)/i,
  /\bsession\b/i,
  /\b(?:api|route|endpoint|handler)s?\b/i,
  /\bvalidation\b/i,
  /\bcrypto\b/i,
  /\bjwt\b/i,
  /\boauth\b/i,
  /\bnats.*creds\b/i,
];

const SECURITY_DIFF_PATTERNS = [
  /\b(?:password|secret|token|api[_-]?key|access[_-]?key)\b/i,
  /\b(?:bcrypt|argon2|scrypt|crypto\.(?:create|hash|sign|verify))\b/,
  /\bbuffer\.from\(.+?,\s*['"]base64['"]\)/i,
  /\bsanitize|escape|validate\b/i,
  /\bSELECT\s+.+?\s+FROM\b/i,
  /\bexec(?:Sync|File)?\(/,
];

export function securityApplies(ctx: ApplicabilityContext): boolean {
  if (ctx.pr.files.some((f) => SECURITY_PATH_PATTERNS.some((re) => re.test(f.path)))) return true;
  return SECURITY_DIFF_PATTERNS.some((re) => re.test(ctx.diff));
}

// ────────────────────────── Architecture ──────────────────────────

export function architectureApplies(ctx: ApplicabilityContext): boolean {
  // Fires on new files, new top-level directories under src/, type or schema
  // changes, or package.json dependency churn. These are the "shape" signals.
  const newFile = /^\+\+\+ b\//m.test(ctx.diff) && /^--- \/dev\/null/m.test(ctx.diff);
  if (newFile) return true;

  const hasSrcRootOrSchema = ctx.pr.files.some(
    (f) =>
      /^src\/[^/]+\.ts$/.test(f.path) ||
      /^src\/(schemas?|types?|models?|domain)\//.test(f.path) ||
      /\.schema\.(?:ts|json)$/.test(f.path),
  );
  if (hasSrcRootOrSchema) return true;

  const packageJsonChanged = ctx.pr.files.some((f) => /(^|\/)package\.json$/.test(f.path));
  if (packageJsonChanged && /"(?:dependencies|devDependencies|peerDependencies)"\s*:/.test(ctx.diff)) {
    return true;
  }

  return false;
}

// ─────────────────── Ecosystem Compliance ──────────────────────────

const ECOSYSTEM_PATH_PATTERNS = [
  /(?:^|\/)cortex\.ya?ml$/,
  /(?:^|\/)arc-manifest\.ya?ml$/,
  /(?:^|\/)bot\.ya?ml$/,
  /\.plist$/,
  /(?:^|\/)agents\.d\//,
  /(?:^|\/)\.claude\//,
  /(?:^|\/)SKILL\.md$/i,
  /(?:^|\/)CLAUDE\.md$/i,
  /(?:^|\/)hooks\//,
  /\.hook\.ts$/,
  /(?:^|\/)settings\.json$/,
];

export function ecosystemComplianceApplies(ctx: ApplicabilityContext): boolean {
  return ctx.pr.files.some((f) => ECOSYSTEM_PATH_PATTERNS.some((re) => re.test(f.path)));
}

// ──────────────────────────── Performance ──────────────────────────

const PERFORMANCE_DIFF_PATTERNS = [
  /\bfor\s*\([^)]*\)\s*\{[\s\S]*?\bawait\b/, // await inside for-loop
  /\.map\([^)]+\)\.filter\([^)]+\)\.(?:map|reduce|filter)\(/, // chained array transforms in one pass
  /\bSELECT\s+\*/i, // wildcard query
  /\bwhile\s*\([^)]*\)\s*\{[\s\S]*?\b(?:fetch|axios|request|http)\b/, // network inside while
  /\bsetInterval\(/,
  /\bsync(?:Sync)?\(/, // sync FS in hot paths
  /\.forEach\([^)]*async/, // async forEach (parallelism trap)
];

const PERFORMANCE_PATH_PATTERNS = [
  /(?:^|\/)src\/.*\/(?:queries?|repository|repo|dao|hot|loop|stream|worker)\//i,
  /\.bench\.ts$/i,
];

export function performanceApplies(ctx: ApplicabilityContext): boolean {
  if (ctx.pr.files.some((f) => PERFORMANCE_PATH_PATTERNS.some((re) => re.test(f.path)))) return true;
  return PERFORMANCE_DIFF_PATTERNS.some((re) => re.test(ctx.diff));
}

// ───────────────────────────── Summary ─────────────────────────────

export interface ApplicabilityResult {
  security: boolean;
  architecture: boolean;
  ecosystemCompliance: boolean;
  performance: boolean;
}

export function evaluateApplicability(ctx: ApplicabilityContext): ApplicabilityResult {
  return {
    security: securityApplies(ctx),
    architecture: architectureApplies(ctx),
    ecosystemCompliance: ecosystemComplianceApplies(ctx),
    performance: performanceApplies(ctx),
  };
}
