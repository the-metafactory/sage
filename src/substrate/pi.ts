import { spawn } from "node:child_process";

import { buildSubstrateEnv } from "./env.ts";
import { runJsonViaTextExtraction } from "./base.ts";
import type {
  Substrate,
  SubstrateRunOptions,
  SubstrateRunResult,
} from "./types.ts";

/**
 * pi.dev substrate — wraps `pi -p` (non-interactive print mode).
 *
 * Lifted from the previous src/pi/runner.ts with one structural change:
 * the bin / provider / model / apiKey / tools overrides come through
 * SubstrateRunOptions (substrate-neutral) rather than the old PiRunOptions.
 * The argv shape is preserved byte-for-byte so a pi-dev release that ships
 * a flag change updates with the same patch.
 *
 * Per-process knobs:
 *   - `PI_BIN`         (binary path; default `pi`)
 *   - `PI_PROVIDER`    (default provider)
 *   - `PI_MODEL`       (default model)
 *   - `PI_API_KEY`     (default api-key — forwarded as `--api-key`)
 *   - `PI_TIMEOUT_MS`  (default timeout)
 */

// 10 minutes. Big PRs (multi-commit, large diffs) often need >5min on
// mid-tier providers; the previous 5min default surfaced as opaque timeouts.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface PiSubstrateConfig {
  /** Default `pi` binary on PATH; override for pinned installs. */
  bin?: string;
  /** Default provider passed via `--provider`. */
  provider?: string;
  /** Default model passed via `--model`. */
  model?: string;
  /** Default api-key passed via `--api-key`. */
  apiKey?: string;
}

export class PiSubstrate implements Substrate {
  readonly name = "pi" as const;
  readonly displayName = "pi.dev";

  constructor(private readonly cfg: PiSubstrateConfig = {}) {}

  get bin(): string {
    return this.cfg.bin ?? process.env.PI_BIN ?? "pi";
  }

  async run(opts: SubstrateRunOptions): Promise<SubstrateRunResult> {
    const provider = opts.provider ?? this.cfg.provider ?? process.env.PI_PROVIDER;
    const model = opts.model ?? this.cfg.model ?? process.env.PI_MODEL;
    const apiKey = opts.apiKey ?? this.cfg.apiKey ?? process.env.PI_API_KEY;

    const args: string[] = ["-p"];
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    if (apiKey) args.push("--api-key", apiKey);
    if (opts.tools && opts.tools.length) args.push("--tools", opts.tools.join(","));
    // System-role prompting is stricter than passing instructions in the
    // user message. Lens callers always set systemPrompt for the JSON
    // contract — improves contract adherence dramatically.
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    // Disable thinking by default for JSON-output callers — the chain-of-
    // thought trace ALWAYS contains prose, which breaks the JSON contract
    // (verified across Gemma, Gemini Flash, DeepSeek). Absence here means
    // "default pi behavior" (don't pass the flag).
    if (opts.thinking) args.push("--thinking", opts.thinking);
    args.push(opts.prompt);

    const childEnv = buildSubstrateEnv({
      substrate: "pi",
      extra: opts.env,
    });

    return spawnAndCollect({
      bin: this.bin,
      args,
      cwd: opts.cwd,
      env: childEnv,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS,
    });
  }

  runJson<T>(opts: SubstrateRunOptions): Promise<{ result: T; raw: SubstrateRunResult }> {
    return runJsonViaTextExtraction<T>((o) => this.run(o), opts);
  }
}

function envTimeoutMs(): number | undefined {
  const raw = Number(process.env.PI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

interface SpawnInput {
  bin: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
}

async function spawnAndCollect(input: SpawnInput): Promise<SubstrateRunResult> {
  const started = Date.now();
  return new Promise<SubstrateRunResult>((resolve, reject) => {
    const child = spawn(input.bin, input.args, {
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi substrate timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

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

    // Write any large content via stdin BEFORE we'd otherwise hit ARG_MAX
    // on the argv path. Wrap in try/catch — if the child exited in the
    // same tick (e.g., `pi` binary missing), stdin may already be ended
    // and `write/end` would otherwise become an unhandled rejection.
    try {
      if (input.stdin !== undefined) child.stdin.write(input.stdin);
      child.stdin.end();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[sage:pi] stdin write/end after-close: ${m}`);
    }
  });
}
