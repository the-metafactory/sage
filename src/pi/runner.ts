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
  stdin?: string;
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

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/**
 * Run pi expecting a JSON object response. Strips fenced code blocks if pi
 * wraps the JSON in ```json ... ``` markdown.
 */
export async function runPiJson<T>(opts: PiRunOptions): Promise<{ result: T; raw: PiRunResult }> {
  const raw = await runPi(opts);
  if (raw.exitCode !== 0) {
    throw new Error(`pi exited with code ${raw.exitCode}: ${raw.stderr || raw.stdout}`);
  }

  const text = stripFences(raw.stdout).trim();
  if (!text) throw new Error("pi returned empty output");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pi output is not valid JSON: ${msg}\n--- output ---\n${text}`);
  }

  return { result: parsed as T, raw };
}

function stripFences(s: string): string {
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/m;
  const m = s.trim().match(fence);
  return m ? (m[1] ?? s) : s;
}
