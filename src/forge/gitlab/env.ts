/**
 * Build the env block forwarded to the `glab` subprocess.
 *
 * Mirror of `forge/github/env.ts` for the GitLab backend. `glab` is
 * trusted but does not need the parent daemon's full env — forwarding
 * provider API keys to `glab` would leak them into a child process that
 * has no business with them. Allow-list the GitLab-specific auth keys
 * plus the same shell essentials.
 *
 * Auth keys reflect `glab` 1.40+ behavior:
 *   - `GITLAB_TOKEN` / `GLAB_TOKEN`: personal access token / OAuth token
 *   - `GITLAB_HOST`: explicit host override; trumps `--hostname`
 *   - `GLAB_CONFIG_DIR`: per-user config dir (used by `glab auth login`)
 */

export const GLAB_SHELL_ESSENTIALS = [
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

export const GLAB_AUTH_KEYS = [
  "GITLAB_TOKEN",
  "GLAB_TOKEN",
  "GITLAB_HOST",
  "GLAB_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

export interface BuildGlabEnvOptions {
  extra?: Record<string, string | undefined>;
  parent?: NodeJS.ProcessEnv;
}

export function buildGlabEnv(opts: BuildGlabEnvOptions = {}): Record<string, string> {
  const parent = opts.parent ?? process.env;
  const out: Record<string, string> = {};

  for (const key of [...GLAB_SHELL_ESSENTIALS, ...GLAB_AUTH_KEYS]) {
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
