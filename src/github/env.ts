/**
 * Build the env block forwarded to the `gh` subprocess.
 *
 * `gh` is trusted but doesn't need the parent daemon's full env. Forwarding
 * provider API keys to `gh` would leak them into a child process that has
 * no business with them. Mirror the allow-list discipline of buildPiEnv()
 * but with a tighter, gh-specific set.
 */

export const GH_SHELL_ESSENTIALS = [
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
  "NO_COLOR",
] as const;

export const GH_AUTH_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

export interface BuildGhEnvOptions {
  extra?: Record<string, string | undefined>;
  parent?: NodeJS.ProcessEnv;
}

export function buildGhEnv(opts: BuildGhEnvOptions = {}): Record<string, string> {
  const parent = opts.parent ?? process.env;
  const out: Record<string, string> = {};

  for (const key of [...GH_SHELL_ESSENTIALS, ...GH_AUTH_KEYS]) {
    const value = parent[key];
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
