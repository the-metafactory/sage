/**
 * Substrate — substrate-neutral surface every coding-harness Sage talks to
 * implements.
 *
 * ISA principle #1: Sage's persona, lens prompts, and verdict logic must not
 * depend on which LLM substrate runs them. This interface is the seam that
 * lets that principle hold in code, not just in the spec.
 *
 * Substrate is pure platform (subprocess + capture). JSON extraction
 * lives in its own Module — each Adapter declares its `jsonExtractors`
 * as data, and lens callers compose a `JsonPipeline` at the call site
 * by pairing those extractors with a caller-owned preferred-shape
 * predicate (sage#57 introduced the Module; sage#73 made Pipeline a
 * per-call composable and moved Lens-shape to the Lens side). Substrates
 * with native structured-output modes (Claude's `--output-format json`)
 * honor `SubstrateRunOptions.responseFormat`; others ignore it.
 *
 * Adding a new substrate (Codex, Aider, …):
 *   1. Drop a new file under src/substrate/ that exports a `Substrate`.
 *   2. Register it in three sites:
 *        - the `SUBSTRATE_NAMES` tuple in `registry.ts`
 *        - the `build()` switch in `select.ts`
 *        - the `SageConfigFile.substrate.<name>` typed field in
 *          `select.ts` so the config loader can carry substrate-specific
 *          overrides
 *   3. Declare `jsonExtractors` — usually `TEXT_EXTRACTORS` for plain-text
 *      stdout, `CLAUDE_EXTRACTORS` for native-envelope shapes.
 *   4. Update README and ISA's substrates table.
 *
 * Nothing else changes — `lenses/base.ts` only sees this interface plus
 * the JSON Module's `extractFromRunOrThrow` entry.
 */

import type { NamedExtractor } from "./json/types.ts";
import type { SubstrateName } from "./registry.ts";

export type { SubstrateName };

/**
 * Env-var contract a Substrate Adapter declares as data. Used by
 * `buildSubstrateEnv` to compose the subprocess env block from the
 * Module-level shared base (shell essentials + Provider keys) plus
 * the Substrate-specific additions.
 *
 * sage#60 — extracts the prior `SUBSTRATE_NAMESPACES` closed-class
 * map into per-Adapter data so adding a 4th Substrate is a single
 * file change.
 *
 * Adapters do NOT list:
 *   - SHELL_ESSENTIALS — Module owns the universal base.
 *   - PROVIDER_KEYS    — Provider is a sage-level concept, not
 *                         per-Substrate (CONTEXT.md). Module owns
 *                         the canonical list.
 *   - SENSITIVE_OPT_IN_KEYS — opt-in is operator policy.
 *   - sage-internal kill-list — Module owns it.
 */
export interface EnvRequirements {
  /**
   * Env-var prefixes forwarded only to this Substrate's subprocess
   * (prefix match: `"PI_"` matches `PI_PROVIDER`, `PI_MODEL`, etc.).
   * Empty array is legal — Adapter has no Substrate-specific
   * namespace.
   */
  readonly namespaces: readonly string[];

  /**
   * Exact-match env-var name additions on top of Module-level
   * shared SHELL_ESSENTIALS + PROVIDER_KEYS. Rarely populated.
   */
  readonly keys: readonly string[];
}

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
   * extraction itself does NOT live behind this flag — callers
   * compose a Pipeline from `substrate.jsonExtractors` and route
   * through `extractFromRunOrThrow(raw, pipeline, substrate.name)`
   * regardless, because text-only substrates can still emit JSON in
   * their text stdout (sage#57 + sage#73).
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
   * Per-Adapter JSON-extraction strategy declared as data. Callers
   * extracting JSON compose this with their own preferred-shape
   * predicate at the call site:
   *
   *   const pipeline: JsonPipeline = {
   *     extractors: substrate.jsonExtractors,
   *     preferredShape: <caller's predicate>,
   *   };
   *   extractFromRun(raw, pipeline, substrate.name);
   *
   * pi/codex declare `TEXT_EXTRACTORS`; claude declares
   * `CLAUDE_EXTRACTORS` (envelope-first then text fallback). The
   * Substrate JSON Module does NOT carry a notion of "preferred
   * shape" — that's a caller-side concern, owned by the consuming
   * Module (Lens kernel pairs with `isLensShaped`) — sage#73 refines
   * sage#57.
   */
  readonly jsonExtractors: readonly NamedExtractor[];

  /**
   * Per-Adapter env contract declared as data. sage#60 — each
   * Substrate Adapter owns its own namespace prefix list next to
   * its `run()` code; `buildSubstrateEnv` reads this to compose
   * the subprocess env block.
   */
  readonly envRequirements: EnvRequirements;

  /**
   * Run the coding task. Implementations spawn the substrate binary as a
   * subprocess, forward an allow-listed env, wait for completion or
   * timeout, and return the captured streams.
   */
  run(opts: SubstrateRunOptions): Promise<SubstrateRunResult>;
}
