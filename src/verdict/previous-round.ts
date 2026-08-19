import type { LensReport } from "../lenses/types.ts";

/** Parse the current-side line locations added by a unified comparison diff. */
export function addedLinesByPath(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let path: string | undefined;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4);
      path = raw === "/dev/null" ? undefined : raw.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!path || newLine === 0 || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      const pathLines = lines.get(path) ?? new Set<number>();
      pathLines.add(newLine);
      lines.set(path, pathLines);
      newLine++;
    } else if (line.startsWith("-")) {
      continue;
    } else {
      newLine++;
    }
  }
  return lines;
}

/** Additive marking: no finding is suppressed or reclassified. */
export function markPreviousRoundSurface(
  lenses: readonly LensReport[],
  addedLines: ReadonlyMap<string, ReadonlySet<number>>,
): LensReport[] {
  return lenses.map((lens) => ({
    ...lens,
    findings: lens.findings.map((finding) => ({
      ...finding,
      ...(addedLines.get(finding.path)?.has(finding.line)
        ? { previousRoundSurface: true }
        : {}),
    })),
  }));
}

/**
 * Every path the comparison diff touches, including files it only deletes from.
 *
 * Applicability is mostly PATH-triggered (`src/lenses/applicability.ts` reads
 * `pr.files` far more than it scans the diff body), so narrowing the diff alone
 * does not stop a settled lens from firing: a PR that ever touched
 * `src/auth.ts` keeps waking the Security lens on every later round no matter
 * what that round changed. Narrowing the file list is the other half.
 */
export function changedPathsInDiff(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    // `diff --git a/x b/x` is read as well as the `---`/`+++` pair, because a
    // mode-only or binary change carries the header and nothing else.
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      paths.add(header[1]!);
      paths.add(header[2]!);
      continue;
    }
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    const raw = line.slice(4).split("\t")[0]!.trim();
    if (raw === "/dev/null" || raw === "") continue;
    paths.add(raw.replace(/^[ab]\//, ""));
  }
  return paths;
}
