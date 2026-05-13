import { spawn } from "node:child_process";

import { buildPiEnv } from "./env.ts";

/**
 * Pi.dev subprocess runner.
 *
 * Invokes the `pi` CLI from @earendil-works/pi-coding-agent in non-interactive
 * print mode. Returns either raw text (default) or a structured review object
 * when a JSON-shape prompt is used.
 */

export interface PiRunOptions {
  /**
   * The instruction passed as `pi -p <prompt>` on the command line. Keep
   * this small — macOS caps argv+env at ~256 KB (ARG_MAX). Put large
   * content (PR diff, file dump) in `stdin` instead.
   */
  prompt: string;
  /**
   * Optional large content streamed to pi via stdin. Pi's documented
   * pattern: `cat README.md | pi -p "Summarize this text"`. Use this for
   * anything that might exceed ARG_MAX.
   */
  stdin?: string;
  /**
   * Optional system prompt (sent as SYSTEM role to the underlying LLM via
   * pi's `--system-prompt` flag). Use this for output-contract directives
   * — the model obeys system-role instructions more strictly than
   * user-message instructions.
   */
  systemPrompt?: string;
  /**
   * Thinking level passthrough — `off | minimal | low | medium | high | xhigh`.
   * Sage's lens calls default to `off` because the chain-of-thought
   * reasoning trace ALWAYS includes prose and broke the JSON contract.
   */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  provider?: string;
  model?: string;
  tools?: readonly string[];
  apiKey?: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Extra env vars forwarded to `pi`. Merged on top of the allow-listed env
   * built by `buildPiEnv()`. Use this when a caller needs to inject a
   * provider key at runtime without mutating `process.env`.
   */
  env?: Record<string, string | undefined>;
  /** Extra keys to forward on top of the default allow-list. */
  envAllow?: readonly string[];
  /** Keys to strip even if otherwise allowed. */
  envDeny?: readonly string[];
}

export interface PiRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

// 10 minutes. Big PRs (multi-commit, large diffs) often need >5min on
// mid-tier providers; the previous 5min default surfaced as opaque
// timeouts on real reviews. Overridable per call or via `PI_TIMEOUT_MS`
// env var (read in runPi below).
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  const bin = process.env.PI_BIN ?? "pi";
  const provider = opts.provider ?? process.env.PI_PROVIDER;
  const model = opts.model ?? process.env.PI_MODEL;
  const apiKey = opts.apiKey ?? process.env.PI_API_KEY;

  const args: string[] = ["-p"];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (apiKey) args.push("--api-key", apiKey);
  if (opts.tools && opts.tools.length) args.push("--tools", opts.tools.join(","));
  // System-role prompting is stricter than passing instructions in the
  // user message. Sage lens callers should always set systemPrompt for
  // the JSON contract — improves contract adherence dramatically.
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  // Disable thinking by default for JSON-output callers — the chain-of-
  // thought trace ALWAYS contains prose, which breaks the JSON contract
  // (verified across Gemma, Gemini Flash, DeepSeek). Lens callers can
  // override with thinking: "off" explicitly; absence means "default
  // pi behavior" (don't pass the flag).
  if (opts.thinking) args.push("--thinking", opts.thinking);
  args.push(opts.prompt);

  const started = Date.now();

  const childEnv = buildPiEnv({
    extra: opts.env,
    allow: opts.envAllow,
    deny: opts.envDeny,
  });

  return new Promise<PiRunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const envTimeoutMs = Number(process.env.PI_TIMEOUT_MS);
    const effectiveTimeoutMs =
      opts.timeoutMs ??
      (Number.isFinite(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi runner timed out after ${effectiveTimeoutMs}ms`));
    }, effectiveTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
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
      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // Don't reject — let the close handler resolve with whatever the
      // child produced. The error here is almost always benign cleanup.
      // eslint-disable-next-line no-console
      console.error(`[sage] pi stdin write/end after-close: ${m}`);
    }
  });
}

/**
 * Run pi expecting a JSON object response. Handles three common wrapper
 * shapes in order: (1) raw JSON, (2) JSON inside ```json … ``` fences,
 * (3) JSON preceded/followed by prose. The lens prompt asks for raw JSON
 * but model outputs vary, so the extractor is forgiving.
 */
export async function runPiJson<T>(opts: PiRunOptions): Promise<{ result: T; raw: PiRunResult }> {
  const raw = await runPi(opts);
  if (raw.exitCode !== 0) {
    throw new Error(`pi exited with code ${raw.exitCode}: ${raw.stderr || raw.stdout}`);
  }

  const text = raw.stdout.trim();
  if (!text) throw new Error("pi returned empty output");

  const parsed = extractJson<T>(text);
  if (parsed === undefined) {
    throw new Error(
      `pi output is not valid JSON (tried raw, fenced, and prose-wrapped extraction)\n--- output ---\n${text}`,
    );
  }

  return { result: parsed, raw };
}

/**
 * Pull a JSON object out of an arbitrary pi response. Tries four shapes in
 * order, returning the first that parses cleanly:
 *
 *   0. Raw — the whole response is valid JSON (the system-prompt-obeyed case).
 *   1. Greedy fence — first opening ```json fence to LAST closing ```.
 *      Handles JSON bodies that contain inline ``` blocks inside
 *      `suggestion` fields (common in review output).
 *   2. Brace slice — first `{` to last `}`. Recovers from prose preambles
 *      ("Here is the review: {…}") and from greedy-fence over-capture.
 *   3. Non-greedy fence — first ```json fence to FIRST closing ```. Last
 *      resort for the rare two-separate-fenced-blocks shape.
 *
 * Returns `undefined` if all four fail.
 */
function extractJson<T>(text: string): T | undefined {
  // Candidate list across multiple shapes, tried in order. Raw goes FIRST
  // (zero false-positive risk when the model obeys the contract — cheap
  // happy path). Then the multi-shape fallbacks for verbose / chain-of-
  // thought / fenced-block outputs.
  const candidates: string[] = [];

  // 1) Raw text — happy path for contract-obeying models.
  candidates.push(text);

  // 2) All fenced blocks, LAST first. Captures both ```json … ``` and
  //    plain ```…``` shapes. Verbose models with reasoning traces almost
  //    always emit their final answer inside the LAST fenced block.
  for (const block of allFencedBlocks(text).reverse()) {
    candidates.push(block);
  }

  // 3) All balanced-brace objects in the text, LARGEST first. The model's
  //    actual review JSON is typically the longest balanced span; smaller
  //    spans tend to be example JSON inside the reasoning trace.
  const balancedAll = findAllBalancedObjects(text).sort(
    (a, b) => b.length - a.length,
  );
  for (const b of balancedAll) candidates.push(b);

  // 4) Trailing balanced object — defensive: walks backwards from the LAST
  //    `}` to find the matching `{`. Handles "reasoning trace + JSON-at-
  //    very-end with no fence" shape that all the patterns above miss.
  const trailing = findTrailingBalancedObject(text);
  if (trailing) candidates.push(trailing);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      // Sanity: the lens contract requires an object with `summary` /
      // `findings`. Accept any other JSON if it parses, but prefer an
      // object that looks lens-shaped. First match wins.
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        ("summary" in parsed || "findings" in parsed)
      ) {
        return parsed as T;
      }
    } catch {
      // Try next candidate.
    }
  }

  // Last resort — accept ANY parseable JSON object/array even if it doesn't
  // look lens-shaped. Caller may still get usable data; lens-shape mismatch
  // surfaces as zero findings downstream rather than a crash.
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Find EVERY balanced object span in the text. Used by extractJson to
 * collect every plausible JSON candidate when the model emits a long
 * reasoning trace with multiple `{...}` shapes inside (e.g. JSON examples
 * inside the prompt instruction, then the actual review at the end).
 */
function findAllBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("{", cursor);
    if (start === -1) break;
    const span = walkBalanced(text, start);
    if (span) {
      objects.push(span);
      cursor = start + span.length;
    } else {
      cursor = start + 1;
    }
  }
  return objects;
}

/**
 * Mirror of findBalancedObject but walking BACKWARDS from the last `}`.
 * Catches "reasoning trace + JSON-at-very-end" shapes where the trailing
 * object is the answer and earlier balanced objects are examples.
 */
function findTrailingBalancedObject(text: string): string | undefined {
  const end = text.lastIndexOf("}");
  if (end === -1) return undefined;

  let depth = 0;
  let inString = false;

  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    // Backwards string-state tracking is asymmetric — escapes precede the
    // escaped char, not follow it. The simplest approximation: track only
    // unescaped quotes by looking at the preceding char each time. Good
    // enough for the LLM-output case where strings are well-formed.
    if (inString) {
      if (ch === '"' && text[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === '"' && text[i - 1] !== "\\") {
      inString = true;
      continue;
    }
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return undefined;
}

/**
 * Shared forward-walk used by findBalancedObject and findAllBalancedObjects.
 */
function walkBalanced(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Extract every fenced block (```…``` and ```json…```) regardless of where
 * it sits in the text. Returns the bodies in document order; caller
 * decides priority.
 */
function allFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  // Greedy across many fences: capture pairs `\`\`\`(json)?\n … \n\`\`\``.
  // Use a stateful regex with `g` flag to walk the string. Non-greedy on
  // the body so multi-block output yields separate captures.
  const re = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) blocks.push(m[1]);
  }
  return blocks;
}
