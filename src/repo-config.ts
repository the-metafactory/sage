import type { ForgeBackend, PrRef } from "./forge/types.ts";

/** Base-revision policy: the reviewed diff cannot silently exempt itself. */
export async function loadGlossaryIgnore(
  forge: ForgeBackend, ref: PrRef, baseRefName: string,
): Promise<string[]> {
  const raw = await forge.repoFile(ref, ".sage.yaml", { refName: baseRefName });
  if (raw === null) return [];
  const config = Bun.YAML.parse(raw) as { glossary?: { ignore?: unknown } } | null;
  const ignore = config?.glossary?.ignore;
  if (ignore === undefined) return [];
  if (!Array.isArray(ignore) || ignore.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(".sage.yaml glossary.ignore must be an array of non-empty strings");
  }
  return [...new Set(ignore.map((value: string) => value.trim().toLowerCase()))];
}
