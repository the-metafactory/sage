import { extractJson, isLensShaped } from "./json.ts";
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
 *   - JSON output uses `--output-format json` natively when the caller
 *     asks for runJson — no fragile text extraction on the happy path.
 *     On the unhappy path we DO NOT re-spawn: `tryParseClaudeEnvelope`
 *     pulls a lens-shaped result out of the captured stdout if at all
 *     possible. Only when no envelope can be parsed at all do we fall
 *     through to `runJsonViaTextExtraction` (which still operates on
 *     captured output, never re-spawns).
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

  // Resolution chain: opts > env > config > default. Mirrors
  // selectSubstrate()'s order so an operator setting CLAUDE_MODEL in the
  // shell consistently wins over sage.config.json without surprising
  // anyone.
  get bin(): string {
    return process.env.CLAUDE_BIN ?? this.cfg.bin ?? "claude";
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

    // Happy path: parse the native envelope and pull a lens-shaped value
    // out of it. If anything from envelope-parse to inner-string-parse
    // fails — but the envelope itself was well-formed — there is no
    // point re-running extractJson over the same envelope text below
    // (it would just return the envelope itself via the "any parseable
    // JSON" last-resort branch, yielding a non-lens object that breaks
    // the downstream lens loop). Catch that case explicitly.
    const envelopeOutcome = tryParseClaudeEnvelope<T>(raw.stdout);
    if (envelopeOutcome.kind === "lens") {
      return { result: envelopeOutcome.value, raw };
    }
    if (envelopeOutcome.kind === "envelope-without-lens") {
      throw new Error(
        "claude `--output-format json` envelope parsed but contained no lens-shaped content " +
          "(neither `summary` nor `findings` in the envelope or its `.result` body)\n" +
          `--- stdout ---\n${raw.stdout}`,
      );
    }

    // envelopeOutcome.kind === "no-envelope" — stdout wasn't a JSON
    // envelope at all (upstream shape change, model deviated, transport
    // mangled bytes). Fall through to text extraction on the captured
    // stdout — never re-spawn (a second spawn doubles API spend on the
    // failure path).
    // eslint-disable-next-line no-console
    console.error(
      "[sage:claude] native --output-format json envelope did not parse; falling back to text extraction on captured stdout. " +
        "Upstream envelope shape may have changed — check claude-code release notes.",
    );

    const recovered = extractJson<T>(raw.stdout);
    if (recovered === undefined || !isLensShaped(recovered)) {
      throw new Error(
        `claude output is not parseable as a lens-shaped JSON (native envelope + text extraction both failed)\n--- stdout ---\n${raw.stdout}`,
      );
    }
    return { result: recovered, raw };
  }

  private buildArgs(opts: SubstrateRunOptions, json: boolean): string[] {
    const model = opts.model ?? process.env.CLAUDE_MODEL ?? this.cfg.model;
    const permissionMode =
      (process.env.CLAUDE_PERMISSION_MODE as ClaudeSubstrateConfig["permissionMode"]) ??
      this.cfg.permissionMode ??
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
    return spawnSubstrateFor({
      name: "claude",
      bin: this.bin,
      args,
      opts,
    });
  }
}

/**
 * Try to extract a lens-shaped result from claude's `--output-format
 * json` envelope. Returns:
 *
 *   - `{ kind: "lens", value }` — found a lens-shaped object via the
 *     envelope's `.result` (or `.response`) inner string, or the
 *     envelope itself was bare lens JSON.
 *   - `{ kind: "envelope-without-lens" }` — envelope parsed but no
 *     lens-shaped value reachable from it. Caller should error rather
 *     than try text extraction on the same stdout (which would just
 *     re-return the envelope itself via the "any parseable JSON"
 *     fallback).
 *   - `{ kind: "no-envelope" }` — stdout isn't a JSON envelope at all.
 *     Caller should fall through to text extraction (upstream may have
 *     changed shape; the model may have skipped the envelope entirely).
 */
type ClaudeEnvelopeOutcome<T> =
  | { kind: "lens"; value: T }
  | { kind: "envelope-without-lens" }
  | { kind: "no-envelope" };

function tryParseClaudeEnvelope<T>(stdout: string): ClaudeEnvelopeOutcome<T> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { kind: "no-envelope" };
  }

  const inner = pickClaudeResultText(envelope);
  if (inner !== undefined) {
    try {
      const parsed = JSON.parse(inner) as T;
      if (isLensShaped(parsed)) return { kind: "lens", value: parsed };
    } catch {
      // Inner string wasn't bare JSON. Try lens-shape extraction on it
      // — handles models that wrap their reply in prose or fences.
    }
    const recovered = extractJson<T>(inner);
    if (recovered !== undefined && isLensShaped(recovered)) {
      return { kind: "lens", value: recovered };
    }
    return { kind: "envelope-without-lens" };
  }

  if (isLensShaped(envelope)) {
    // No `.result` field but the envelope itself is lens-shaped — some
    // claude versions print the lens JSON bare when no tools were
    // invoked.
    return { kind: "lens", value: envelope as T };
  }

  return { kind: "envelope-without-lens" };
}

/**
 * Claude Code's `--output-format json` envelope shape (as of claude-code
 * v1.x) places the assistant's text response in `.result`. Be defensive
 * — some legacy releases used `.response` instead. Returns undefined
 * when neither key is found.
 */
function pickClaudeResultText(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const obj = envelope as Record<string, unknown>;
  if (typeof obj.result === "string") return obj.result;
  if (typeof obj.response === "string") return obj.response;
  return undefined;
}
