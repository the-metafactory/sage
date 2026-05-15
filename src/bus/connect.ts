import { connect, credsAuthenticator, type NatsConnection } from "nats";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Shared NATS connect helper used by the daemon (`bridge.ts`) AND the
 * dispatcher (`dispatcher.ts`). Handles creds-path resolution, ENOENT
 * soft-fallback (cortex-creds-not-yet-minted is a legitimate dev state),
 * authenticator setup, and optional refuse-without-auth enforcement.
 *
 * Wire-layer module — uses the `nats` package directly. Envelope + subject
 * concerns live in `@the-metafactory/myelin`. Migration to myelin's
 * `NATSTransport` is a follow-up.
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
  /**
   * When true, refuse to connect without a usable creds file. Prevents
   * silent degradation to an unauthenticated bus in production. Default
   * false for dev compatibility; consumers set true via env / CLI flag
   * (SAGE_REQUIRE_NATS_AUTH).
   */
  requireAuth?: boolean;
}

function resolveCredsPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("~/")) return raw.replace(/^~/, homedir());
  return raw;
}

export async function connectNats(opts: ConnectOptions): Promise<NatsConnection> {
  const log = opts.log ?? (() => {});

  const connectOpts: Parameters<typeof connect>[0] = { servers: opts.natsUrl };
  const credsPath = resolveCredsPath(opts.credsFile ?? process.env.NATS_CREDS_FILE);

  if (credsPath && existsSync(credsPath)) {
    connectOpts.authenticator = credsAuthenticator(readFileSync(credsPath));
    log(`using NATS creds at ${credsPath}`);
  } else if (opts.requireAuth) {
    const detail = credsPath
      ? `NATS_CREDS_FILE=${credsPath} does not exist`
      : "no NATS_CREDS_FILE / credsFile";
    throw new Error(
      `requireAuth=true but no usable NATS creds (${detail}); refusing to connect unauthenticated`,
    );
  } else if (credsPath) {
    log(`NATS_CREDS_FILE=${credsPath} does not exist — connecting unauthenticated`);
  } else {
    log(`connecting unauthenticated (no NATS_CREDS_FILE / credsFile)`);
  }

  return connect(connectOpts);
}
