import { homedir } from "node:os";

/**
 * Expand a tilde-prefixed path to the absolute home-anchored form.
 * Used by both the daemon (`bridge.ts`) and the dispatcher CLI
 * (`cli/dispatch.ts`) — extracted here so credential-resolution rules
 * (XDG, Windows expansion, additional env-var fallbacks) only need one
 * implementation when they grow.
 */
export function resolveCredsPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("~/")) return raw.replace(/^~/, homedir());
  return raw;
}
