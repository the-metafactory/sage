import { runPiJson } from "../pi/runner.ts";
import type { PrMetadata } from "../github/gh.ts";
import type { Finding, LensReport } from "./types.ts";

interface RawLensOutput {
  summary: string;
  findings: Array<Partial<Finding> & { path: string; line: number | string; title: string }>;
}

const SYSTEM_PROMPT = `You are Sage, a senior code reviewer in the metafactory ecosystem. You evaluate one
pull request through a single lens at a time. Be direct, evidence-based, and concise.

CRITICAL OUTPUT CONTRACT: your response MUST be a single JSON object. The first
character of your response MUST be \`{\` and the last character MUST be \`}\`.
No preamble like "Here is the review:". No postamble. No markdown fences. No
prose outside the JSON. Anything else breaks the downstream parser.

JSON shape:

{
  "summary": "<2-3 sentence high-level take>",
  "findings": [
    {
      "path": "<file path>",
      "line": <int>,
      "severity": "blocker" | "important" | "suggestion" | "nit",
      "title": "<short headline>",
      "rationale": "<why this matters, 1-3 sentences>",
      "suggestion": "<optional concrete fix>"
    }
  ]
}

Severity rules:
- blocker:    code is incorrect, unsafe, or breaks contracts. Merging would cause harm.
- important:  the change works but degrades quality (readability, perf, maintainability) in a way that warrants change before merge.
- suggestion: optional improvement.
- nit:        cosmetic.

Be honest. An empty findings array is a valid response.`;

export async function reviewCodeQuality(input: {
  pr: PrMetadata;
  diff: string;
  lensName?: string;
  timeoutMs?: number;
}): Promise<LensReport> {
  const lens = input.lensName ?? "CodeQuality";
  const started = Date.now();

  const userPrompt = buildPrompt(input.pr, input.diff);
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  const { result } = await runPiJson<RawLensOutput>({
    prompt: fullPrompt,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });

  const findings = (result.findings ?? []).map<Finding>((f) => ({
    path: f.path,
    line: normalizeLine(f.line),
    severity: (f.severity as Finding["severity"]) ?? "suggestion",
    title: f.title,
    rationale: f.rationale ?? "",
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
  }));

  return {
    lens,
    summary: result.summary ?? "",
    findings,
    durationMs: Date.now() - started,
  };
}

/**
 * Coerce an LLM-supplied line number into a finite positive int, falling back
 * to 0 (file-level) on anything we cannot trust. Explicit about each failure
 * shape so a reader doesn't need to mentally trace the `NaN || 0` chain.
 */
function normalizeLine(raw: number | string | undefined): number {
  if (raw === undefined || raw === null) return 0;
  const parsed = typeof raw === "string" ? parseInt(raw, 10) : raw;
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  return parsed;
}

function buildPrompt(pr: PrMetadata, diff: string): string {
  const fileList = pr.files
    .map((f) => `  - ${f.path} (+${f.additions} / -${f.deletions})`)
    .join("\n");

  return `PR #${pr.number}: ${pr.title}
Author: ${pr.author.login}
Base: ${pr.baseRefName} ← Head: ${pr.headRefName}
Changed files (${pr.changedFiles}):
${fileList}

Description:
${pr.body || "(no description)"}

---
Unified diff:

${diff}

---
Review this PR through the CodeQuality lens. Focus on correctness, clarity, error handling,
edge cases, and idiomatic style. Surface only real issues — do not invent findings. Reply
with the JSON shape specified above.`;
}
