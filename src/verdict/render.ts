import type { Verdict } from "./types.ts";

/**
 * Render a Verdict to the markdown body posted to the Forge (the
 * Review comment, in CONTEXT.md terms). Pure — takes a Verdict + an
 * optional Substrate label for the footer, returns the markdown
 * string. Used by `reviewPr` (workflow.ts) before posting, and by
 * `sage review` (cli/index.ts) for stdout display.
 */
export function renderVerdict(verdict: Verdict, substrateLabel?: string): string {
  const head = `## Sage code review — ${verdict.decision}\n\n${verdict.summary}\n`;
  const sections = verdict.lenses.map((lens) => {
    const heading = lens.errored
      ? `### ${lens.lens} — DID NOT RUN`
      : `### ${lens.lens}`;
    const intro = lens.errored
      ? "> ⚠ Lens failed to execute. Verdict cannot rely on this lens's coverage; re-run before merging."
      : lens.summary;
    const body =
      lens.findings.length === 0
        ? "_No findings._"
        : lens.findings
            .map((f) => {
              const lensTag =
                f.sourceLenses && f.sourceLenses.length > 1
                  ? `\n  Lenses: ${f.sourceLenses.join(", ")}`
                  : "";
              const findingHead = `- **[${f.severity}]** \`${f.path}:${f.line}\` — **${f.title}**\n  ${f.rationale}${lensTag}`;
              if (!f.suggestion) return findingHead;
              const fence = pickFence(f.suggestion);
              return `${findingHead}\n  \n  Suggestion:\n\n  ${fence}\n  ${f.suggestion.replace(/\n/g, "\n  ")}\n  ${fence}`;
            })
            .join("\n\n");
    return `${heading}\n${intro}\n\n${body}`;
  });
  const footer = `\n---\n_Posted by Sage on ${substrateLabel ?? "pi.dev"} substrate._`;
  return [head, ...sections, footer].join("\n\n");
}

/**
 * Pick a code-fence delimiter longer than any run of backticks
 * inside the content. Prevents triple-backtick injection when an
 * LLM-supplied `suggestion` contains its own fenced code block.
 */
function pickFence(content: string): string {
  let maxRun = 0;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length > maxRun) maxRun = m[0].length;
  }
  return "`".repeat(Math.max(3, maxRun + 1));
}
