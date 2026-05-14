import {
  DEFAULT_SUBSTRATE_TIMEOUT_MS,
  readTimeoutFromEnv,
  spawnSubstrate,
} from "./base.ts";
import { buildSubstrateEnv } from "./env.ts";
import type {
  SubstrateName,
  SubstrateRunOptions,
  SubstrateRunResult,
} from "./types.ts";

export interface SpawnSubstrateForInput {
  name: SubstrateName;
  bin: string;
  args: string[];
  opts: SubstrateRunOptions;
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
