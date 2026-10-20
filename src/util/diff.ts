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
