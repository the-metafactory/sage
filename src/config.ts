import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  if (process.env.CORTEX_CONFIG) return process.env.CORTEX_CONFIG;

  const cortexHome = join(homedir(), ".config", "cortex");
  const monolith = join(cortexHome, "cortex.yaml");
  if (existsSync(monolith)) return monolith;

  // Cortex config-split deployments retain a small, selected-stack sentinel at
  // this location. Prefer it over Sage's historic "metafactory" fallback: a
  // task addressed to the wrong principal is otherwise accepted by NATS but
  // never claimed by Cortex.
  const defaultStack = join(cortexHome, "default", "default.yaml");
  if (existsSync(defaultStack)) return defaultStack;

  return monolith;
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
    if (typeof id === "string" && id !== "") return id;

    // A config-split sentinel is intentionally almost empty. Its basename
    // selects the stack fragment that contains the principal identity.
    const stackDoc = Bun.YAML.parse(
      readFileSync(join(dirname(path), "stacks", `${basename(path, ".yaml")}.yaml`), "utf8"),
    ) as { principal?: { id?: unknown } } | null | undefined;
    const stackId = stackDoc?.principal?.id;
    return typeof stackId === "string" && stackId !== "" ? stackId : undefined;
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
export function resolveDefaultPrincipal(
  resolvePrincipal: () => string | undefined = resolvePrincipalFromConfig,
): string {
  return process.env.SAGE_ORG ?? resolvePrincipal() ?? "metafactory";
}

/** Resolve the selected Cortex stack segment with the same config precedence. */
export function resolveDefaultStack(path: string = cortexConfigPath()): string | undefined {
  try {
    const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as
      | { stack?: { id?: unknown } }
      | null
      | undefined;
    const id = doc?.stack?.id;
    if (typeof id === "string") {
      const [, stack] = id.split("/", 2);
      if (stack) return stack;
    }
    const inferred = basename(path, ".yaml");
    return inferred === "cortex" ? undefined : inferred;
  } catch {
    return undefined;
  }
}
