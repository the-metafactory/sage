import { textExtractionRunJson } from "./json.ts";
import { spawnSubstrateFor } from "./spawn.ts";
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
  readonly runJson = textExtractionRunJson((opts) => this.run(opts));

  constructor(private readonly cfg: PiSubstrateConfig = {}) {}

  // Resolution chain mirrors selectSubstrate(): per-call opts > env >
  // config > built-in default. The env layer sits between caller-supplied
  // overrides and the daemon's startup config so an operator can adjust
  // a single run via `PI_PROVIDER=… sage review …` without touching
  // sage.config.json.
  get bin(): string {
    return process.env.PI_BIN ?? this.cfg.bin ?? "pi";
  }

  async run(opts: SubstrateRunOptions): Promise<SubstrateRunResult> {
    const provider = opts.provider ?? process.env.PI_PROVIDER ?? this.cfg.provider;
    const model = opts.model ?? process.env.PI_MODEL ?? this.cfg.model;
    const apiKey = opts.apiKey ?? process.env.PI_API_KEY ?? this.cfg.apiKey;

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

    return spawnSubstrateFor({
      name: "pi",
      bin: this.bin,
      args,
      opts,
    });
  }

}
