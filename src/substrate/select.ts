import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ClaudeSubstrate, type ClaudeSubstrateConfig } from "./claude.ts";
import { CodexSubstrate, type CodexSubstrateConfig } from "./codex.ts";
import { PiSubstrate, type PiSubstrateConfig } from "./pi.ts";
import { SUBSTRATE_NAMES, type Substrate, type SubstrateName } from "./types.ts";

/**
 * Resolve which substrate Sage uses for this process. Resolution order
 * (first non-empty wins):
 *
 *   1. CLI flag    — explicit `--substrate {pi|claude|codex}`
 *   2. Env         — `SAGE_SUBSTRATE`
 *   3. Config file — ~/.config/sage/config.json → `substrate.default`
 *   4. Built-in    — "pi" (preserves pre-#14 behavior)
 *
 * Selection is *daemon-level* — once resolved at startup, every task this
 * Sage process handles uses the same substrate. Per-task substrate selection
 * is deliberately not supported (see issue #14 "Out of scope").
 */

export type SubstrateSource = "flag" | "env" | "config" | "default";

export interface SubstrateSelection {
  name: SubstrateName;
  source: SubstrateSource;
  substrate: Substrate;
}

export interface SageConfigFile {
  substrate?: {
    default?: SubstrateName;
    pi?: PiSubstrateConfig;
    claude?: ClaudeSubstrateConfig;
    codex?: CodexSubstrateConfig;
  };
}

export interface SelectSubstrateOptions {
  /** Explicit --substrate from the CLI. Highest priority when set. */
  flag?: string;
  /** Override the env source (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Override the config file path (defaults to ~/.config/sage/config.json). */
  configPath?: string;
  /** Pre-loaded config for tests; skips disk read when set. */
  config?: SageConfigFile;
}

export function selectSubstrate(opts: SelectSubstrateOptions = {}): SubstrateSelection {
  const env = opts.env ?? process.env;

  let name: SubstrateName | undefined;
  let source: SubstrateSource | undefined;

  const fromFlag = normalize(opts.flag);
  if (fromFlag) {
    name = fromFlag;
    source = "flag";
  }

  if (!name) {
    const fromEnv = normalize(env.SAGE_SUBSTRATE);
    if (fromEnv) {
      name = fromEnv;
      source = "env";
    }
  }

  const cfg = opts.config ?? readConfigFile(opts.configPath);
  if (!name) {
    const fromCfg = normalize(cfg?.substrate?.default);
    if (fromCfg) {
      name = fromCfg;
      source = "config";
    }
  }

  if (!name) {
    name = "pi";
    source = "default";
  }

  const substrate = build(name, cfg);
  return { name, source: source ?? "default", substrate };
}

function normalize(raw: string | undefined | null): SubstrateName | undefined {
  if (!raw) return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === "") return undefined;
  if (!SUBSTRATE_NAMES.includes(lower as SubstrateName)) {
    throw new Error(
      `unknown substrate "${raw}" — supported: ${SUBSTRATE_NAMES.join(", ")}`,
    );
  }
  return lower as SubstrateName;
}

function build(name: SubstrateName, cfg: SageConfigFile | undefined): Substrate {
  switch (name) {
    case "pi":
      return new PiSubstrate(cfg?.substrate?.pi ?? {});
    case "claude":
      return new ClaudeSubstrate(cfg?.substrate?.claude ?? {});
    case "codex":
      return new CodexSubstrate(cfg?.substrate?.codex ?? {});
  }
}

function readConfigFile(explicitPath?: string): SageConfigFile | undefined {
  const path = explicitPath ?? join(homedir(), ".config", "sage", "config.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as SageConfigFile;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[sage] failed to parse ${path}: ${err instanceof Error ? err.message : String(err)} — ignoring`,
    );
    return undefined;
  }
}
