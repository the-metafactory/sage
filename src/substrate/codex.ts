import { buildSubstrateEnv } from "./env.ts";
import { readTimeoutFromEnv, spawnSubstrate } from "./base.ts";
import { runJsonViaTextExtraction } from "./json.ts";
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
 *   - `CODEX_TIMEOUT_MS` (default timeout)
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SANDBOX = "read-only";
const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

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

  constructor(private readonly cfg: CodexSubstrateConfig = {}) {}

  get bin(): string {
    return process.env.CODEX_BIN ?? this.cfg.bin ?? "codex";
  }

  async run(opts: SubstrateRunOptions): Promise<SubstrateRunResult> {
    const model = opts.model ?? process.env.CODEX_MODEL ?? this.cfg.model;
    const profile = process.env.CODEX_PROFILE ?? this.cfg.profile;
    const sandbox = resolveSandbox(process.env.CODEX_SANDBOX ?? this.cfg.sandbox);

    const args: string[] = [
      "exec",
      "--ephemeral",
      "--ask-for-approval",
      "never",
      "--sandbox",
      sandbox,
    ];
    if (model) args.push("--model", model);
    if (profile) args.push("--profile", profile);
    args.push(buildPrompt(opts));

    return spawnSubstrate({
      bin: this.bin,
      args,
      env: buildSubstrateEnv({ substrate: "codex", extra: opts.env }),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeoutMs:
        opts.timeoutMs ?? readTimeoutFromEnv("CODEX_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
      label: "codex",
    });
  }

  runJson<T>(opts: SubstrateRunOptions): Promise<{ result: T; raw: SubstrateRunResult }> {
    return runJsonViaTextExtraction<T>((o) => this.run(o), opts);
  }
}

function resolveSandbox(raw: string | undefined): CodexSandbox {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return DEFAULT_SANDBOX;
  if (isCodexSandbox(trimmed)) return trimmed;
  throw new Error(
    `invalid CODEX_SANDBOX "${trimmed}" — supported: ${CODEX_SANDBOXES.join(", ")}`,
  );
}

function isCodexSandbox(raw: string): raw is CodexSandbox {
  return CODEX_SANDBOXES.includes(raw as CodexSandbox);
}

function buildPrompt(opts: SubstrateRunOptions): string {
  if (!opts.systemPrompt) return opts.prompt;
  return [
    "System instructions:",
    opts.systemPrompt,
    "",
    "User task:",
    opts.prompt,
  ].join("\n");
}
