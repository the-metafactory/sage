import { buildSubstrateEnv } from "./env.ts";
import { extractJson, spawnSubstrate } from "./base.ts";
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
 *     for runJson — no fragile text extraction on the happy path. On the
 *     UNHAPPY path we DO NOT re-spawn: the already-captured stdout buffer
 *     is fed through the same text-extraction logic used by substrates
 *     without a native JSON mode, and a `console.error` warning is logged
 *     so operators can detect upstream envelope-shape changes before they
 *     become silent regressions.
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

    // Claude Code's `--output-format json` envelope places the assistant's
    // text reply in `.result`. The lens prompt asks the assistant for a
    // JSON-shaped reply, so the actual lens body sits inside `.result` as
    // a string. Parse twice (envelope, then result body) on the happy
    // path; on every other path, fall through to `extractJson` over the
    // ALREADY-CAPTURED stdout — never re-spawn (a second spawn doubles
    // API spend on the failure path).
    try {
      const envelope = JSON.parse(raw.stdout) as unknown;
      const inner = pickClaudeResultText(envelope);
      if (inner !== undefined) {
        try {
          const parsed = JSON.parse(inner) as T;
          return { result: parsed, raw };
        } catch {
          // Inner string isn't bare JSON. Try lens-shape extraction on
          // it — handles models that wrap their reply in prose or fences.
          const recovered = extractJson<T>(inner);
          if (recovered !== undefined) return { result: recovered, raw };
        }
      } else if (looksLensShaped(envelope)) {
        // No `.result` field but the envelope itself is lens-shaped —
        // some claude versions print the lens JSON bare when no tools
        // were invoked.
        return { result: envelope as T, raw };
      }
    } catch {
      // Envelope itself didn't parse — fall through to raw-stdout
      // extraction below.
    }

    // eslint-disable-next-line no-console
    console.error(
      "[sage:claude] native --output-format json parse failed; falling back to text extraction on captured stdout. " +
        "Upstream envelope shape may have changed — check claude-code release notes.",
    );

    const recovered = extractJson<T>(raw.stdout);
    if (recovered === undefined) {
      throw new Error(
        `claude output is not parseable as JSON (native envelope + text extraction both failed)\n--- stdout ---\n${raw.stdout}`,
      );
    }
    return { result: recovered, raw };
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
    return spawnSubstrate({
      bin: this.bin,
      args,
      env: buildSubstrateEnv({ substrate: "claude", extra: opts.env }),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeoutMs: opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS,
      label: "claude",
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
 * neither key is found, signaling the caller to try the lens-shape branch
 * or raw-stdout extraction.
 */
function pickClaudeResultText(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const obj = envelope as Record<string, unknown>;
  if (typeof obj.result === "string") return obj.result;
  if (typeof obj.response === "string") return obj.response;
  return undefined;
}

function looksLensShaped(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("summary" in (value as Record<string, unknown>) ||
      "findings" in (value as Record<string, unknown>))
  );
}
