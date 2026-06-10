import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Operator-config resolution (sage#85).
 *
 * sage's `dispatch` command publishes review-request tasks onto
 * `local.{org}.{stack}.tasks.code-review.*`. The `{org}` segment MUST match
 * the cortex review consumer's principal (e.g. `jc`), or the task lands on a
 * subject nobody subscribes → silent timeout. Resolve the principal from the
 * same cortex.yaml pilot / cortex read so a stock operator never has to pass
 * `--org` by hand.
 */

/**
 * Path to the cortex config. `$CORTEX_CONFIG` override, else the canonical
 * `~/.config/cortex/cortex.yaml` (the monolithic file pilot reads).
 */
export function cortexConfigPath(): string {
  return process.env.CORTEX_CONFIG ?? join(homedir(), ".config", "cortex", "cortex.yaml");
}

/**
 * Read `principal.id` from a cortex.yaml. Best-effort: a missing file,
 * unreadable file, parse error, or absent/empty `principal.id` all resolve to
 * `undefined` — never throws, so a malformed config degrades to the next
 * default tier rather than crashing the CLI.
 *
 * `path` is injectable for tests; production callers use {@link cortexConfigPath}.
 */
export function resolvePrincipalFromConfig(path: string = cortexConfigPath()): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as
      | { principal?: { id?: unknown } }
      | null
      | undefined;
    const id = doc?.principal?.id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the default `dispatch --org` value. Precedence:
 *   1. `SAGE_ORG` env (explicit operator override)
 *   2. cortex.yaml `principal.id` (the correct value for this stack)
 *   3. `"metafactory"` (last-resort back-compat for callers with neither)
 *
 * An explicit `--org` flag overrides this entirely (commander uses the default
 * only when the flag is absent).
 *
 * `resolvePrincipal` is injectable for tests; production uses
 * {@link resolvePrincipalFromConfig}.
 */
export function resolveDefaultOrg(
  resolvePrincipal: () => string | undefined = resolvePrincipalFromConfig,
): string {
  return process.env.SAGE_ORG ?? resolvePrincipal() ?? "metafactory";
}
