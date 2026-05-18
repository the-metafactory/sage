/**
 * Resolve a `ForgeBackend` instance once per CLI invocation or bus
 * task. Mirrors the shape of `substrate/select.ts`: precedence is
 * explicit flag → environment variable → URL detection → default
 * (GitHub). Source tracking lets the CLI log which signal won so
 * operators can debug surprising forge selections.
 */

import {
  DEFAULT_GITLAB_HOST,
  GitLabBackend,
} from "./gitlab/backend.ts";
import { GitHubBackend } from "./github/backend.ts";
import { detectForgeKindFromRef } from "./parse.ts";
import type { ForgeBackend, ForgeKind } from "./types.ts";

export type ForgeSelectionSource = "flag" | "env" | "ref" | "default";

export interface ForgeSelection {
  backend: ForgeBackend;
  kind: ForgeKind;
  source: ForgeSelectionSource;
}

export interface SelectForgeOptions {
  /** Explicit CLI flag, e.g. `--forge gitlab`. */
  flag?: string;
  /** PR/MR ref string — used for URL-shape detection when flag/env are absent. */
  fromRef?: string;
  /** Default GitLab host when the GitLab backend is selected. */
  gitlabHost?: string;
  /** Environment block to read SAGE_FORGE / SAGE_GITLAB_HOST from. */
  env?: NodeJS.ProcessEnv;
}

export function selectForge(opts: SelectForgeOptions = {}): ForgeSelection {
  const env = opts.env ?? process.env;
  const { kind, source } = resolveKindAndSource(opts, env);
  const backend = buildBackend(kind, opts, env);
  return { backend, kind, source };
}

/**
 * Walk the precedence ladder ONCE and return both the resolved
 * `kind` and the `source` that won. Sage review on #47
 * (Maintainability nit): the previous split into `resolveKind` +
 * `resolveSource` duplicated the ladder, so adding a new signal
 * would have required two synchronized edits.
 */
function resolveKindAndSource(
  opts: SelectForgeOptions,
  env: NodeJS.ProcessEnv,
): { kind: ForgeKind; source: ForgeSelectionSource } {
  if (opts.flag !== undefined && opts.flag !== "") {
    return { kind: assertForgeKind(opts.flag, "--forge"), source: "flag" };
  }
  const fromEnv = env.SAGE_FORGE?.trim();
  if (fromEnv) {
    return { kind: assertForgeKind(fromEnv, "SAGE_FORGE"), source: "env" };
  }
  if (opts.fromRef) {
    const detected = detectForgeKindFromRef(opts.fromRef);
    if (detected) return { kind: detected, source: "ref" };
  }
  return { kind: "github", source: "default" };
}

function buildBackend(
  kind: ForgeKind,
  opts: SelectForgeOptions,
  env: NodeJS.ProcessEnv,
): ForgeBackend {
  if (kind === "gitlab") {
    const host =
      opts.gitlabHost?.trim() ||
      env.SAGE_GITLAB_HOST?.trim() ||
      DEFAULT_GITLAB_HOST;
    return new GitLabBackend({ defaultHost: host });
  }
  return new GitHubBackend();
}

function assertForgeKind(value: string, source: string): ForgeKind {
  if (value === "github" || value === "gitlab") return value;
  throw new Error(
    `${source} must be "github" or "gitlab" (got ${JSON.stringify(value)})`,
  );
}
