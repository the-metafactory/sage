/**
 * Substrate — substrate-neutral surface every coding-harness Sage talks to
 * implements.
 *
 * ISA principle #1: Sage's persona, lens prompts, and verdict logic must not
 * depend on which LLM substrate runs them. This interface is the seam that
 * lets that principle hold in code, not just in the spec.
 *
 * Adding a new substrate (Codex, Aider, …):
 *   1. Drop a new file under src/substrate/ that exports a `Substrate`.
 *   2. Register it in three sites:
 *        - the `SubstrateName` union below
 *        - the `VALID` list and the `build()` switch in `select.ts`
 *        - the `SageConfigFile.substrate.<name>` typed field in
 *          `select.ts` so the config loader can carry substrate-specific
 *          overrides
 *   3. Update README and ISA's substrates table.
 *
 * Nothing else changes — `lenses/base.ts` calls `substrate.runJson(opts)` and
 * only sees this interface.
 */

export type SubstrateName = "pi" | "claude" | "codex";

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
   * Run the coding task. Implementations spawn the substrate binary as a
   * subprocess, forward an allow-listed env, wait for completion or
   * timeout, and return the captured streams.
   */
  run(opts: SubstrateRunOptions): Promise<SubstrateRunResult>;

  /**
   * Convenience for when the prompt asks for a single JSON-shaped reply.
   * Default implementation in `base.ts` strips fenced code blocks and
   * JSON.parses the result. Substrates with a native structured-output
   * mode (Claude Code's `--output-format json`) override directly.
   */
  runJson<T>(opts: SubstrateRunOptions): Promise<{ result: T; raw: SubstrateRunResult }>;
}
