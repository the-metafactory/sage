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
  prompt: string;
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

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi runner timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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

    child.stdin.end();
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
 * Pull a JSON object out of an arbitrary pi response. Tries three shapes
 * before giving up:
 *
 *   1. The whole string parses cleanly.
 *   2. A ```json … ``` (or ```…```) fenced block parses cleanly. Uses a
 *      greedy match anchored on the LAST closing fence so inline ``` blocks
 *      inside the JSON body don't truncate the payload.
 *   3. The slice from the first `{` to the last `}` parses cleanly — covers
 *      "Here is the review: { … }" style preambles.
 *
 * Returns `undefined` if none of the three produce a parseable object.
 */
function extractJson<T>(text: string): T | undefined {
  const candidates: string[] = [text];

  const fence = /^```(?:json)?\s*\n([\s\S]*)\n```\s*$/;
  const fenceMatch = text.match(fence);
  if (fenceMatch && fenceMatch[1]) candidates.push(fenceMatch[1]);

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}
