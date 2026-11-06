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

/** Globs a repository keeps out of review; base revision only, so a diff cannot exempt itself. */
export async function loadReviewExclude(
  forge: ForgeBackend, ref: PrRef, baseRefName: string,
): Promise<string[]> {
  const raw = await forge.repoFile(ref, ".sage.yaml", { refName: baseRefName });
  if (raw === null) return [];
  const config = Bun.YAML.parse(raw) as { review?: { exclude?: unknown } } | null;
  const exclude = config?.review?.exclude;
  if (exclude === undefined) return [];
  if (!Array.isArray(exclude) || exclude.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(".sage.yaml review.exclude must be an array of non-empty strings");
  }
  return [...new Set(exclude.map((value: string) => value.trim()))];
}

export interface DiffExclusion {
  diff: string;
  excludedPaths: string[];
}

/** Drops each file section whose old or new path matches; an unparseable header stays reviewed. */
export function excludeFromDiff(diff: string, patterns: readonly string[]): DiffExclusion {
  if (patterns.length === 0) return { diff, excludedPaths: [] };
  const globs = patterns.map((pattern) => new Bun.Glob(pattern));
  const matches = (path: string) => globs.some((glob) => glob.match(path));
  const excludedPaths: string[] = [];
  const kept = diff.split(/^(?=diff --git )/m).filter((section) => {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    if (!header) return true;
    const matched = [header[1]!, header[2]!].find(matches);
    if (matched === undefined) return true;
    excludedPaths.push(matched);
    return false;
  });
  return { diff: kept.join(""), excludedPaths };
}
