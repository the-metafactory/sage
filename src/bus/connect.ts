import { connect, credsAuthenticator, type NatsConnection } from "nats";
import { existsSync, readFileSync } from "node:fs";

import { resolveCredsPath } from "./creds.ts";

/**
 * Shared NATS connect helper used by the daemon (`bridge.ts`) AND the
 * dispatcher (`dispatcher.ts`). Handles creds-path resolution, ENOENT
 * soft-fallback (cortex-creds-not-yet-minted is a legitimate dev state),
 * authenticator setup, and connection. Callers diverge only in what they
 * subscribe to.
 *
 * Single source of truth — TLS, JWT, reconnect options etc. evolve here
 * and both callers stay in sync automatically.
 */

export interface ConnectOptions {
  natsUrl: string;
  /** Path to a NATS user `.creds` file. Falls back to NATS_CREDS_FILE env. */
  credsFile?: string;
  /**
   * Logger callback. Both callers want their own prefix ("bridge:" /
   * "dispatch:") on connect-related log lines.
   */
  log?: (msg: string) => void;
}

export async function connectNats(opts: ConnectOptions): Promise<NatsConnection> {
  const log = opts.log ?? (() => {});

  const connectOpts: Parameters<typeof connect>[0] = { servers: opts.natsUrl };
  const credsPath = resolveCredsPath(opts.credsFile ?? process.env.NATS_CREDS_FILE);

  if (credsPath && existsSync(credsPath)) {
    connectOpts.authenticator = credsAuthenticator(readFileSync(credsPath));
    log(`using NATS creds at ${credsPath}`);
  } else if (credsPath) {
    // Env points at a creds file that doesn't exist — common when sage is
    // installed via arc but `cortex creds issue sage` hasn't yet run, or
    // when running against an unauthenticated local broker. Soft-fall to
    // unauthenticated rather than crash on ENOENT.
    log(`NATS_CREDS_FILE=${credsPath} does not exist — connecting unauthenticated`);
  } else {
    log(`connecting unauthenticated (no NATS_CREDS_FILE / credsFile)`);
  }

  return connect(connectOpts);
}
