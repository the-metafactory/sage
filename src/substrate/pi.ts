import { buildSubstrateEnv } from "./env.ts";
import { runJsonViaTextExtraction, spawnSubstrate } from "./base.ts";
import type {
  Substrate,
  SubstrateRunOptions,
  SubstrateRunResult,
} from "./types.ts";

/**
 * pi.dev substrate — wraps `pi -p` (non-interactive print mode).
 *
 * Argv shape is preserved byte-for-byte from the previous src/pi/runner.ts so
 * a pi-dev release that ships a flag change updates with the same patch.
 *
 * Per-process knobs:
 *   - `PI_BIN`         (binary path; default `pi`)
 *   - `PI_PROVIDER`    (default provider)
 *   - `PI_MODEL`       (default model)
 *   - `PI_API_KEY`     (default api-key — forwarded as `--api-key`. Visible
 *     in `ps` / `/proc/<pid>/cmdline`; pi.dev does not currently expose an
 *     env-only auth path, so the argv approach is the documented surface.)
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

    return spawnSubstrate({
      bin: this.bin,
      args,
      env: buildSubstrateEnv({ substrate: "pi", extra: opts.env }),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeoutMs: opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS,
      label: "pi",
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
