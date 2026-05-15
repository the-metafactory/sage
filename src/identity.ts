import type { Sovereignty } from "@the-metafactory/myelin";

const RESIDENCY_RE = /^[A-Z]{2}$/;

/**
 * Resolve the data-residency code for outbound envelopes.
 *
 * Precedence: explicit caller override → `MYELIN_DATA_RESIDENCY` env →
 * `SAGE_DATA_RESIDENCY` env (legacy fallback, kept for the deployed
 * launchd plist that still names it) → `"CH"` default. Validated on
 * every call so a misconfigured value surfaces near the publish call
 * that produced it (no import-time silent capture).
 */
export function resolveResidency(override?: string): string {
  const raw =
    override ??
    process.env.MYELIN_DATA_RESIDENCY ??
    process.env.SAGE_DATA_RESIDENCY ??
    "CH";
  if (!RESIDENCY_RE.test(raw)) {
    throw new Error(
      `data residency "${raw}" must be a 2-letter uppercase ISO 3166 code`,
    );
  }
  return raw;
}

/**
 * Build a Sovereignty struct with sage's defaults, allowing per-call
 * overrides. Reads residency at call time so multi-tenant runs and
 * tests with multiple residencies each see their own value.
 */
export function buildSovereignty(overrides?: Partial<Sovereignty>): Sovereignty {
  return {
    classification: overrides?.classification ?? "local",
    data_residency: resolveResidency(overrides?.data_residency),
    max_hop: overrides?.max_hop ?? 0,
    frontier_ok: overrides?.frontier_ok ?? true,
    model_class: overrides?.model_class ?? "any",
  };
}
