import { CLAUDE_PIPELINE } from "./json/pipelines.ts";
import { spawnSubstrateFor } from "./spawn.ts";
import type {
  Substrate,
  SubstrateRunOptions,
  SubstrateRunResult,
} from "./types.ts";

/**
 * Claude Code substrate — wraps `claude -p` (non-interactive print mode,
 * the same surface PAI scripts use via `k prompt`).
 *
 * Differences from the pi substrate:
 *   - Model is passed via `--model` (Claude Code model IDs:
 *     `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`).
 *   - System prompt is passed via `--system-prompt` (parity with pi).
 *   - `--permission-mode` is exposed for daemon scenarios where Sage runs
 *     unattended (defaults to `acceptEdits` so the substrate doesn't
 *     block waiting for an approval that will never come).
 *   - `--output-format json` is appended to the argv when the caller
 *     sets `SubstrateRunOptions.responseFormat = "json"`. The native
 *     envelope is then parsed by the `CLAUDE_ENVELOPE` extractor in
 *     `src/substrate/json/`; the Pipeline falls back to text-extraction
 *     strategies on the same captured stdout if the envelope shape
 *     drifts (sage#57). Never re-spawns.
 *   - The `thinking`, `provider`, `apiKey`, and `tools`
 *     SubstrateRunOptions fields are ignored — Claude Code doesn't
 *     expose those knobs.
 *
 * Provider/model envs honored from the operator's shell:
 *   - `CLAUDE_BIN`             (binary path; default `claude`)
 *   - `CLAUDE_MODEL`           (default model)
 *   - `CLAUDE_PERMISSION_MODE` (default `acceptEdits` for daemon use)
 *   - `CLAUDE_TIMEOUT_MS`      (default timeout)
 *   - `ANTHROPIC_API_KEY`      (forwarded automatically by the env builder)
 */

const DEFAULT_PERMISSION_MODE = "acceptEdits";

export interface ClaudeSubstrateConfig {
  bin?: string;
  model?: string;
  /** Maps to claude --permission-mode. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
}

export class ClaudeSubstrate implements Substrate {
  readonly name = "claude" as const;
  readonly displayName = "Claude Code";
  readonly jsonPipeline = CLAUDE_PIPELINE;

  constructor(private readonly cfg: ClaudeSubstrateConfig = {}) {}

  // Resolution chain: opts > env > config > default. Mirrors
  // selectSubstrate()'s order so an operator setting CLAUDE_MODEL in the
  // shell consistently wins over sage.config.json without surprising
  // anyone.
  get bin(): string {
    return process.env.CLAUDE_BIN ?? this.cfg.bin ?? "claude";
  }

  async run(opts: SubstrateRunOptions): Promise<SubstrateRunResult> {
    const args = this.buildArgs(opts);
    return spawnSubstrateFor({
      name: "claude",
      bin: this.bin,
      args,
      opts,
    });
  }

  private buildArgs(opts: SubstrateRunOptions): string[] {
    const model = opts.model ?? process.env.CLAUDE_MODEL ?? this.cfg.model;
    const permissionMode =
      (process.env.CLAUDE_PERMISSION_MODE as ClaudeSubstrateConfig["permissionMode"]) ??
      this.cfg.permissionMode ??
      DEFAULT_PERMISSION_MODE;

    const args = ["-p"];
    if (model) args.push("--model", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    // Native structured-output mode. The `CLAUDE_ENVELOPE` extractor
    // in `src/substrate/json/` pulls the lens body out of the envelope's
    // `.result`/`.response` field. Falls through to text extraction
    // (same captured stdout) if the envelope shape drifts.
    if (opts.responseFormat === "json") args.push("--output-format", "json");
    args.push(opts.prompt);
    return args;
  }
}
