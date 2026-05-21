/**
 * Substrate — substrate-neutral surface every coding-harness Sage talks to
 * implements.
 *
 * ISA principle #1: Sage's persona, lens prompts, and verdict logic must not
 * depend on which LLM substrate runs them. This interface is the seam that
 * lets that principle hold in code, not just in the spec.
 *
 * Substrate is pure platform (subprocess + capture). JSON extraction
 * lives in its own Module — each Adapter declares its `jsonPipeline`
 * as data, and lens callers route through
 * `extractFromRunOrThrow(raw, substrate.jsonPipeline, substrate.name)`
 * (sage#57). Substrates with native structured-output modes (Claude's
 * `--output-format json`) honor `SubstrateRunOptions.responseFormat`;
 * others ignore it.
 *
 * Adding a new substrate (Codex, Aider, …):
 *   1. Drop a new file under src/substrate/ that exports a `Substrate`.
 *   2. Register it in three sites:
 *        - the `SUBSTRATE_NAMES` tuple in `registry.ts`
 *        - the `build()` switch in `select.ts`
 *        - the `SageConfigFile.substrate.<name>` typed field in
 *          `select.ts` so the config loader can carry substrate-specific
 *          overrides
 *   3. Declare `jsonPipeline` — usually `TEXT_PIPELINE` for plain-text
 *      stdout, `CLAUDE_PIPELINE` for native-envelope shapes.
 *   4. Update README and ISA's substrates table.
 *
 * Nothing else changes — `lenses/base.ts` only sees this interface plus
 * the JSON Module's `extractFromRunOrThrow` entry.
 */

import type { JsonPipeline } from "./json/types.ts";
import type { SubstrateName } from "./registry.ts";

export type { SubstrateName };

/**
 * Thinking-level passthrough. Sage's lens calls default to `off` because the
 * chain-of-thought trace empirically broke the JSON contract on weaker models
 * (Gemma, Gemini Flash, DeepSeek). Substrates that don't expose a thinking
 * knob (Claude Code today) ignore this — it's a hint, not a contract.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface SubstrateRunOptions {
  /**
   * The instruction passed to the coding harness. Keep this small —
   * macOS caps argv+env at ~256 KB (ARG_MAX). Put large content (PR diff,
   * file dump) in `stdin` instead.
   */
  prompt: string;
  /** Optional large content streamed via stdin. */
  stdin?: string;
  /**
   * Optional system-role prompt. Substrates that distinguish system vs
   * user roles obey system-role directives more strictly — used for the
   * JSON output contract on lens calls.
   */
  systemPrompt?: string;
  /** Thinking level (substrate-specific; pi honors it, claude ignores it). */
  thinking?: ThinkingLevel;
  /** Working directory for the substrate subprocess. */
  cwd?: string;
  /** Hard timeout in milliseconds. Per-substrate default applies when omitted. */
  timeoutMs?: number;
  /** Provider override (substrate-specific semantics). */
  provider?: string;
  /** Model override (substrate-specific identifier). */
  model?: string;
  /** API-key override (passed as `--api-key` to substrates that accept one). */
  apiKey?: string;
  /** Optional tool-list passthrough (pi.dev `--tools`). */
  tools?: readonly string[];
  /** Extra env vars merged into the substrate child env. */
  env?: Record<string, string | undefined>;
  /**
   * Hint to the Adapter that the caller expects JSON. Substrates with a
   * native structured-output mode (claude: `--output-format json`)
   * honor it; others (pi, codex) ignore it. Default: `"text"`. JSON
   * extraction itself does NOT live behind this flag — callers route
   * through `extractFromRunOrThrow(raw, substrate.jsonPipeline, ...)`
   * regardless, because text-only substrates can still emit JSON in
   * their text stdout (sage#57).
   */
  responseFormat?: "text" | "json";
}

export interface SubstrateRunResult {
  /** Substrate stdout — typically the final text response. */
  stdout: string;
  /** Substrate stderr — diagnostic, progress, tool-use traces. */
  stderr: string;
  /** Subprocess exit code (-1 if killed). */
  exitCode: number;
  /** Wall-clock duration. */
  durationMs: number;
}

export interface Substrate {
  /** Stable identifier — also the key used in SAGE_SUBSTRATE / --substrate. */
  readonly name: SubstrateName;
  /** Display name for logs and the verdict envelope's `extensions.substrate`. */
  readonly displayName: string;
  /** Binary path used (post-resolution). */
  readonly bin: string;
  /**
   * Per-Adapter JSON-extraction Pipeline declared as data. Callers
   * extracting JSON from this Substrate's output run
   * `extractFromRun(raw, substrate.jsonPipeline, substrate.name)`.
   * pi/codex declare `TEXT_PIPELINE`; claude declares
   * `CLAUDE_PIPELINE` (envelope-first then text fallback) — sage#57.
   */
  readonly jsonPipeline: JsonPipeline;

  /**
   * Run the coding task. Implementations spawn the substrate binary as a
   * subprocess, forward an allow-listed env, wait for completion or
   * timeout, and return the captured streams.
   */
  run(opts: SubstrateRunOptions): Promise<SubstrateRunResult>;
}
