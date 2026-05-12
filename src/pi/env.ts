/**
 * Build the env block forwarded to the `pi` subprocess.
 *
 * Goals:
 *   1. Forward provider API keys (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, …) so
 *      pi can authenticate against whichever backend it's configured for.
 *   2. Forward minimal shell essentials (PATH, HOME, USER, LANG, …) so the
 *      binary resolves and can find its config.
 *   3. Forward anything prefixed `PI_` so pi.dev's own configuration env is
 *      honored.
 *   4. Avoid blanket `process.env` passthrough — keeps secret blast radius
 *      tight when Sage runs as a daemon under systemd / launchd and inherits
 *      a noisy parent env.
 *
 * Override behavior:
 *   - `PI_ENV_ALLOW` (comma-separated) adds keys to the allow-list.
 *   - `PI_ENV_DENY` (comma-separated) removes keys from the allow-list.
 *   - The `extra` argument is merged in last and wins on conflict — used by
 *     the CLI to inject runtime overrides.
 */

/** Provider keys Sage forwards by default. Add to this list when a new provider matters. */
export const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "FIREWORKS_API_KEY",
  "AZURE_API_KEY",
  "AZURE_API_BASE",
  "AZURE_API_VERSION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
] as const;

/** Shell essentials. Without these `pi` can't even resolve its binary. */
export const SHELL_ESSENTIALS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
] as const;

/**
 * Keys that are useful for some pi runtimes but carry injection risk in
 * production. `NODE_OPTIONS` can `--require` arbitrary files into pi's Node
 * runtime if the parent env was poisoned. NOT forwarded by default.
 * Operators who genuinely need it must opt in via `PI_ENV_ALLOW=NODE_OPTIONS`.
 */
export const SENSITIVE_OPT_IN_KEYS = ["NODE_OPTIONS"] as const;

export interface BuildPiEnvOptions {
  /** Caller-supplied extra env vars; merged last and win on conflict. */
  extra?: Record<string, string | undefined>;
  /** Additional keys to forward on top of the default allow-list. */
  allow?: readonly string[];
  /** Keys to strip even if otherwise allowed. */
  deny?: readonly string[];
  /** Parent env to read from. Defaults to `process.env`. */
  parent?: NodeJS.ProcessEnv;
}

/**
 * Sage-internal `PI_*` keys that configure Sage's own forwarding behavior.
 * They must NEVER reach the pi subprocess — leaking the parent's security
 * policy is operational metadata pi has no business with.
 */
const SAGE_INTERNAL_PI_KEYS = new Set<string>(["PI_ENV_ALLOW", "PI_ENV_DENY"]);

export function buildPiEnv(opts: BuildPiEnvOptions = {}): Record<string, string> {
  const parent = opts.parent ?? process.env;

  const parentAllow = parseEnvList(parent.PI_ENV_ALLOW);
  const parentDeny = parseEnvList(parent.PI_ENV_DENY);

  // Build the default allow-list from the safe lists only. SENSITIVE
  // keys are deliberately omitted from SHELL_ESSENTIALS / PROVIDER_KEYS;
  // they re-enter the set ONLY when the caller's `allow` or the parent's
  // `PI_ENV_ALLOW` explicitly names them. This positive-add structure
  // makes the opt-in-only semantics self-evident.
  const allowSet = new Set<string>([
    ...SHELL_ESSENTIALS,
    ...PROVIDER_KEYS,
    ...(opts.allow ?? []),
    ...parentAllow,
  ]);
  for (const key of SENSITIVE_OPT_IN_KEYS) {
    const explicitlyAllowed =
      parentAllow.includes(key) || (opts.allow?.includes(key) ?? false);
    if (explicitlyAllowed) allowSet.add(key);
    // else: not added — sensitive keys are off by default, no delete needed.
  }

  const denySet = new Set<string>([
    ...(opts.deny ?? []),
    ...parentDeny,
    ...SAGE_INTERNAL_PI_KEYS,
  ]);

  const out: Record<string, string> = {};

  // Forward allow-listed exact keys.
  for (const key of allowSet) {
    if (denySet.has(key)) continue;
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }

  // Forward any key prefixed with PI_ — pi.dev's own configuration namespace.
  // Sage-internal config (PI_ENV_ALLOW / PI_ENV_DENY) is denied above so the
  // subprocess does not see the parent's forwarding policy.
  for (const [key, value] of Object.entries(parent)) {
    if (!key.startsWith("PI_")) continue;
    if (denySet.has(key)) continue;
    if (value !== undefined) out[key] = value;
  }

  // Caller overrides win.
  if (opts.extra) {
    for (const [key, value] of Object.entries(opts.extra)) {
      if (value === undefined) {
        delete out[key];
      } else {
        out[key] = value;
      }
    }
  }

  return out;
}

function parseEnvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
