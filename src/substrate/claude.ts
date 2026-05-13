import { spawn } from "node:child_process";

import { buildSubstrateEnv } from "./env.ts";
import { runJsonViaTextExtraction } from "./base.ts";
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
 *     unattended (defaults to `acceptEdits` so the substrate doesn't block
 *     waiting for an approval that will never come).
 *   - JSON output uses `--output-format json` natively when the caller asks
 *     for runJson — no fragile text extraction on the happy path. Falls
 *     back to runJsonViaTextExtraction if the native JSON envelope shape
 *     changes upstream.
 *   - The `thinking`, `provider`, `apiKey`, and `tools` SubstrateRunOptions
 *     fields are ignored — Claude Code doesn't expose those knobs.
 *
 * Provider/model envs honored from the operator's shell:
 *   - `CLAUDE_BIN`             (binary path; default `claude`)
 *   - `CLAUDE_MODEL`           (default model)
 *   - `CLAUDE_PERMISSION_MODE` (default `acceptEdits` for daemon use)
 *   - `CLAUDE_TIMEOUT_MS`      (default timeout)
 *   - `ANTHROPIC_API_KEY`      (forwarded automatically by the env builder)
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
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

  constructor(private readonly cfg: ClaudeSubstrateConfig = {}) {}

  get bin(): string {
    return this.cfg.bin ?? process.env.CLAUDE_BIN ?? "claude";
  }

  async run(opts: SubstrateRunOptions): Promise<SubstrateRunResult> {
    const args = this.buildArgs(opts, /* json */ false);
    return this.spawnClaude(args, opts);
  }

  async runJson<T>(
    opts: SubstrateRunOptions,
  ): Promise<{ result: T; raw: SubstrateRunResult }> {
    const args = this.buildArgs(opts, /* json */ true);
    const raw = await this.spawnClaude(args, opts);
    if (raw.exitCode !== 0) {
      throw new Error(
        `claude exited with code ${raw.exitCode}: ${raw.stderr || raw.stdout}`,
      );
    }
    // With --output-format json claude prints a JSON envelope whose
    // `result` field holds the assistant's text reply. The lens prompt
    // asks the assistant for a JSON-shaped reply, so the actual lens JSON
    // sits inside `result` as a string. Parse twice: envelope, then
    // result body. If either fails, fall back to text extraction.
    try {
      const envelope = JSON.parse(raw.stdout) as unknown;
      const inner = pickClaudeResultText(envelope);
      if (inner !== undefined) {
        const parsed = JSON.parse(inner) as T;
        return { result: parsed, raw };
      }
      // Envelope shape didn't match — try treating the whole stdout as
      // the JSON the caller wants. Some claude versions print the result
      // bare when no tools were used.
      return { result: envelope as T, raw };
    } catch {
      return runJsonViaTextExtraction<T>((o) => this.run(o), opts);
    }
  }

  private buildArgs(opts: SubstrateRunOptions, json: boolean): string[] {
    const model = opts.model ?? this.cfg.model ?? process.env.CLAUDE_MODEL;
    const permissionMode =
      this.cfg.permissionMode ??
      (process.env.CLAUDE_PERMISSION_MODE as ClaudeSubstrateConfig["permissionMode"]) ??
      DEFAULT_PERMISSION_MODE;

    const args = ["-p"];
    if (model) args.push("--model", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    if (json) args.push("--output-format", "json");
    args.push(opts.prompt);
    return args;
  }

  private async spawnClaude(
    args: string[],
    opts: SubstrateRunOptions,
  ): Promise<SubstrateRunResult> {
    const childEnv = buildSubstrateEnv({
      substrate: "claude",
      extra: opts.env,
    });

    const timeoutMs = opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    return new Promise<SubstrateRunResult>((resolve, reject) => {
      const child = spawn(this.bin, args, {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });

      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude substrate timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs: Date.now() - started,
        });
      });

      try {
        if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
        child.stdin.end();
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`[sage:claude] stdin write/end after-close: ${m}`);
      }
    });
  }
}

function envTimeoutMs(): number | undefined {
  const raw = Number(process.env.CLAUDE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * Claude Code's `--output-format json` envelope shape (as of claude-code
 * v1.x) places the assistant's text response in `.result`. Be defensive —
 * some legacy releases used `.response` instead. Returns undefined when
 * neither key is found, signaling the caller to try text extraction.
 */
function pickClaudeResultText(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const obj = envelope as Record<string, unknown>;
  if (typeof obj.result === "string") return obj.result;
  if (typeof obj.response === "string") return obj.response;
  return undefined;
}
