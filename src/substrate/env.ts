/**
 * Build the env block forwarded to a substrate subprocess.
 *
 * Goals (generalizes the previous src/pi/env.ts):
 *   1. Forward provider API keys (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, …)
 *      so the substrate can authenticate against whichever backend it's
 *      configured for.
 *   2. Forward shell essentials (PATH, HOME, USER, LANG, …) so the binary
 *      resolves and finds its config.
 *   3. Forward substrate-specific namespaces — `PI_*` only to pi, `CLAUDE_*`
 *      and `ANTHROPIC_*` only to claude. Keeps each substrate's config env
 *      isolated.
 *   4. Avoid blanket `process.env` passthrough — keeps secret blast radius
 *      tight when Sage runs as a daemon under systemd / launchd and inherits
 *      a noisy parent env.
 *
 * Override behavior:
 *   - `SAGE_ENV_ALLOW` (comma-separated) adds keys to the allow-list.
 *   - `SAGE_ENV_DENY` (comma-separated) removes keys from the allow-list.
 *   - `PI_ENV_ALLOW` / `PI_ENV_DENY` are still honored for back-compat
 *     (operators with the legacy env vars don't need to migrate).
 *   - The `extra` argument is merged last and wins on conflict.
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

/** Shell essentials. Without these the substrate binary can't even resolve. */
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
 * Keys that are useful for some substrate runtimes but carry injection risk
 * in production. `NODE_OPTIONS` can `--require` arbitrary files into a
 * Node-based substrate's runtime if the parent env was poisoned. NOT
 * forwarded by default; opt in via `SAGE_ENV_ALLOW=NODE_OPTIONS` (or the
 * legacy `PI_ENV_ALLOW=NODE_OPTIONS`).
 */
export const SENSITIVE_OPT_IN_KEYS = ["NODE_OPTIONS"] as const;

/**
 * Substrate namespaces. Each substrate's own config env (PI_PROVIDER,
 * CLAUDE_MODEL, ANTHROPIC_API_KEY, …) is forwarded only to that substrate.
 * Provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) are forwarded
 * unconditionally via PROVIDER_KEYS — listing ANTHROPIC_ here only ensures
 * any *other* ANTHROPIC_* config var also makes it through.
 */
export const SUBSTRATE_NAMESPACES = {
  pi: ["PI_"],
  claude: ["CLAUDE_", "ANTHROPIC_"],
} as const;

export type SubstrateNamespaceKey = keyof typeof SUBSTRATE_NAMESPACES;

export interface BuildSubstrateEnvOptions {
  /** Which substrate this env is for — controls namespace forwarding. */
  substrate: SubstrateNamespaceKey;
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
 * Sage-internal keys that must NEVER reach the substrate. Some are
 * forwarding-policy (`SAGE_ENV_ALLOW/DENY`, legacy `PI_ENV_ALLOW/DENY`);
 * others are the daemon's own identity (`SAGE_DID`, `SAGE_ORG`, …) which
 * pi/claude have no business with.
 */
const SAGE_INTERNAL_KEYS = new Set<string>([
  "SAGE_ENV_ALLOW",
  "SAGE_ENV_DENY",
  "SAGE_SUBSTRATE",
  "SAGE_AGENT_ID",
  "SAGE_DID",
  "SAGE_SOURCE",
  "SAGE_ORG",
  "SAGE_DATA_RESIDENCY",
  "PI_ENV_ALLOW",
  "PI_ENV_DENY",
]);

export function buildSubstrateEnv(opts: BuildSubstrateEnvOptions): Record<string, string> {
  const parent = opts.parent ?? process.env;

  // SAGE_ENV_ALLOW/DENY are the modern controls; PI_ENV_ALLOW/DENY remain
  // honored so operators using the legacy var names keep working. SAGE_*
  // wins on conflict (sage > pi). Both are stripped from the forwarded env
  // via SAGE_INTERNAL_KEYS so the substrate never sees the parent's policy.
  const parentAllow = [
    ...parseEnvList(parent.PI_ENV_ALLOW),
    ...parseEnvList(parent.SAGE_ENV_ALLOW),
  ];
  const parentDeny = [
    ...parseEnvList(parent.PI_ENV_DENY),
    ...parseEnvList(parent.SAGE_ENV_DENY),
  ];

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
  }

  const denySet = new Set<string>([
    ...(opts.deny ?? []),
    ...parentDeny,
    ...SAGE_INTERNAL_KEYS,
  ]);

  const out: Record<string, string> = {};

  for (const key of allowSet) {
    if (denySet.has(key)) continue;
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }

  // Forward keys in the active substrate's namespaces only.
  const namespaces = SUBSTRATE_NAMESPACES[opts.substrate];
  for (const [key, value] of Object.entries(parent)) {
    if (!namespaces.some((ns) => key.startsWith(ns))) continue;
    if (denySet.has(key)) continue;
    if (SAGE_INTERNAL_KEYS.has(key)) continue;
    if (value !== undefined) out[key] = value;
  }

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
