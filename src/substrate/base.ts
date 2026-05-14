import { spawn } from "node:child_process";

import { buildSubstrateEnv } from "./env.ts";
import type { SubstrateName, SubstrateRunOptions, SubstrateRunResult } from "./types.ts";

/**
 * Shared subprocess primitive for substrates.
 *
 * Spawn the binary, buffer stdout/stderr, enforce a timeout via SIGKILL,
 * write optional stdin, return the captured streams. Lifted out of the
 * old per-substrate spawn blocks (sage#15 review) so Codex and future
 * substrates only have to build argv/env and call this helper.
 *
 * JSON-extraction utilities live in `./json.ts` — kept separate because
 * spawning and parsing are independent concerns.
 */

export interface SpawnSubstrateInput {
  /** Binary name or path. */
  bin: string;
  /** Argv to pass after the binary. */
  args: string[];
  /** Substrate-specific env (already built via `buildSubstrateEnv`). */
  env: Record<string, string>;
  /** Optional working directory. */
  cwd?: string;
  /** Optional stdin payload (large content too big for argv). */
  stdin?: string;
  /** Hard timeout in ms. Substrate is SIGKILLed on expiry. */
  timeoutMs: number;
  /**
   * Short label used in error messages and the after-close stdin warning
   * (e.g. `pi`, `claude`, `codex`). Lets a future substrate add itself without
   * patching the spawn path.
   */
  label: string;
}

export const DEFAULT_SUBSTRATE_TIMEOUT_MS = 10 * 60 * 1000;

export interface SpawnSubstrateForInput {
  name: SubstrateName;
  bin: string;
  args: string[];
  opts: SubstrateRunOptions;
}

/**
 * Read a substrate-specific timeout env var (PI_TIMEOUT_MS,
 * CLAUDE_TIMEOUT_MS, CODEX_TIMEOUT_MS, …). Shared helper so substrates don't need
 * to copy-paste the parse + guard. Returns `undefined` when the env var
 * is unset, NaN, or non-positive — caller decides the substrate default.
 */
export function readTimeoutFromEnv(key: string): number | undefined {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function spawnSubstrateFor(input: SpawnSubstrateForInput): Promise<SubstrateRunResult> {
  const timeoutKey = `${input.name.toUpperCase()}_TIMEOUT_MS`;
  const opts = input.opts;
  return spawnSubstrate({
    bin: input.bin,
    args: input.args,
    env: buildSubstrateEnv({ substrate: input.name, extra: opts.env }),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    timeoutMs:
      opts.timeoutMs ?? readTimeoutFromEnv(timeoutKey) ?? DEFAULT_SUBSTRATE_TIMEOUT_MS,
    label: input.name,
  });
}

export async function spawnSubstrate(input: SpawnSubstrateInput): Promise<SubstrateRunResult> {
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
      reject(new Error(`${input.label} substrate timed out after ${input.timeoutMs}ms`));
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
    // same tick (e.g., binary missing), stdin may already be ended and
    // `write/end` would otherwise become an unhandled rejection.
    try {
      if (input.stdin !== undefined) child.stdin.write(input.stdin);
      child.stdin.end();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[sage:${input.label}] stdin write/end after-close: ${m}`);
    }
  });
}
