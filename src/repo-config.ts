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

/** Every old/new reading of a `diff --git` line: a path containing " b/" makes it ambiguous. */
function headerPathPairs(header: string): Array<[string, string]> {
  const paths = header.slice("diff --git a/".length);
  const pairs: Array<[string, string]> = [];
  for (let at = paths.indexOf(" b/"); at !== -1; at = paths.indexOf(" b/", at + 1)) {
    pairs.push([paths.slice(0, at), paths.slice(at + " b/".length)]);
  }
  return pairs;
}

/**
 * Drops a file section only when every reading of its header has both paths
 * matching, so a rename out of an excluded path stays reviewed. Sections start
 * only after a real newline, because an added line can hold a bare CR or U+2028.
 * A quoted or unparseable header stays reviewed.
 */
export function excludeFromDiff(diff: string, patterns: readonly string[]): DiffExclusion {
  if (patterns.length === 0) return { diff, excludedPaths: [] };
  const globs = patterns.map((pattern) => new Bun.Glob(pattern));
  const matches = (path: string) => globs.some((glob) => glob.match(path));
  const excludedPaths: string[] = [];
  const kept = diff.split(/(?<=^|\n)(?=diff --git )/).filter((section) => {
    const end = section.indexOf("\n");
    const header = end === -1 ? section : section.slice(0, end);
    if (!header.startsWith("diff --git a/")) return true;
    const pairs = headerPathPairs(header);
    if (pairs.length === 0 || !pairs.every(([from, to]) => matches(from) && matches(to))) return true;
    excludedPaths.push(pairs[0]![1]);
    return false;
  });
  return { diff: kept.join(""), excludedPaths };
}
