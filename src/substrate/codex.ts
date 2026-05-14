import { textExtractionRunJson } from "./json.ts";
import { spawnSubstrateFor } from "./spawn.ts";
import type {
  Substrate,
  SubstrateRunOptions,
  SubstrateRunResult,
} from "./types.ts";

/**
 * Codex CLI substrate — wraps `codex exec` in non-interactive mode.
 *
 * Per-process knobs:
 *   - `CODEX_BIN`        (binary path; default `codex`)
 *   - `CODEX_MODEL`      (default model passed as `--model`)
 *   - `CODEX_PROFILE`    (default config profile passed as `--profile`)
 *   - `CODEX_SANDBOX`    (default sandbox; built-in default `read-only`)
 *   - `CODEX_SYSTEM_PROMPT_MODE` (`inband`, or `native` for CLIs verified to
 *     support `--system-prompt`; default `inband`)
 *   - `CODEX_TIMEOUT_MS` (default timeout)
 */

const DEFAULT_SANDBOX = "read-only";
const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
type CodexSandbox = (typeof CODEX_SANDBOXES)[number];
const CODEX_SYSTEM_PROMPT_MODES = ["inband", "native"] as const;
type CodexSystemPromptMode = (typeof CODEX_SYSTEM_PROMPT_MODES)[number];

export interface CodexSubstrateConfig {
  /** Default `codex` binary on PATH; override for pinned installs. */
  bin?: string;
  /** Default model passed via `--model`. */
  model?: string;
  /** Default config profile passed via `--profile`. */
  profile?: string;
  /** Default sandbox passed via `--sandbox`. */
  sandbox?: CodexSandbox;
}

export class CodexSubstrate implements Substrate {
  readonly name = "codex" as const;
  readonly displayName = "Codex CLI";
  readonly runJson = textExtractionRunJson((opts) => this.run(opts));

  constructor(private readonly cfg: CodexSubstrateConfig = {}) {}

  get bin(): string {
    return process.env.CODEX_BIN ?? this.cfg.bin ?? "codex";
  }

  async run(opts: SubstrateRunOptions): Promise<SubstrateRunResult> {
    const model = opts.model ?? process.env.CODEX_MODEL ?? this.cfg.model;
    const profile = process.env.CODEX_PROFILE ?? this.cfg.profile;
    const sandbox =
      process.env.CODEX_SANDBOX !== undefined
        ? parseSandbox("CODEX_SANDBOX", process.env.CODEX_SANDBOX)
        : parseSandbox("codex sandbox config", this.cfg.sandbox);

    // codex 0.130+ removed `--ask-for-approval` from `codex exec`. `exec`
    // is non-interactive by construction (no TTY = no prompts), so the
    // prior `--ask-for-approval never` was already a no-op on those
    // versions and is now a hard parse error (`error: unexpected
    // argument '--ask-for-approval' found`). Rely on `--sandbox` as the
    // safety boundary; approval policy, if a caller needs to pin it
    // explicitly, is now set through TOML override (`-c approval_policy=...`).
    const args: string[] = [
      "exec",
      "--ephemeral",
      "--sandbox",
      sandbox,
    ];
    if (model) args.push("--model", model);
    if (profile) args.push("--profile", profile);
    args.push(...buildPromptArgs(opts));

    return spawnSubstrateFor({
      name: "codex",
      bin: this.bin,
      args,
      opts,
    });
  }

}

function parseSandbox(source: string, raw: string | undefined): CodexSandbox {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return DEFAULT_SANDBOX;
  if (isCodexSandbox(trimmed)) return trimmed;
  throw new Error(
    `invalid ${source} "${trimmed}" — supported: ${CODEX_SANDBOXES.join(", ")}`,
  );
}

function isCodexSandbox(raw: string): raw is CodexSandbox {
  return CODEX_SANDBOXES.includes(raw as CodexSandbox);
}

function buildPromptArgs(opts: SubstrateRunOptions): string[] {
  if (!opts.systemPrompt) return [opts.prompt];
  const mode = parseSystemPromptMode(process.env.CODEX_SYSTEM_PROMPT_MODE);
  if (mode === "native") return ["--system-prompt", opts.systemPrompt, opts.prompt];
  return [[
    "System instructions:",
    opts.systemPrompt,
    "",
    "User task:",
    opts.prompt,
  ].join("\n")];
}

function parseSystemPromptMode(raw: string | undefined): CodexSystemPromptMode {
  const mode = raw?.trim() || "inband";
  if (isSystemPromptMode(mode)) return mode;
  throw new Error(
    `invalid CODEX_SYSTEM_PROMPT_MODE "${mode}" — supported: ${CODEX_SYSTEM_PROMPT_MODES.join(", ")}`,
  );
}

function isSystemPromptMode(raw: string): raw is CodexSystemPromptMode {
  return CODEX_SYSTEM_PROMPT_MODES.includes(raw as CodexSystemPromptMode);
}
