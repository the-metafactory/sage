import { runPiJson } from "../pi/runner.ts";
import type { PrMetadata } from "../github/gh.ts";
import type { Finding, LensReport } from "./types.ts";

interface RawLensOutput {
  summary: string;
  findings: Array<Partial<Finding> & { path: string; line: number | string; title: string }>;
}

const SYSTEM_PROMPT = `You are Sage, a senior code reviewer in the metafactory ecosystem. You evaluate one
pull request through a single lens at a time. Be direct, evidence-based, and concise.

Output strict JSON with this shape — no prose outside the JSON, no markdown fences:

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
}): Promise<LensReport> {
  const lens = input.lensName ?? "CodeQuality";
  const started = Date.now();

  const userPrompt = buildPrompt(input.pr, input.diff);
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  const { result } = await runPiJson<RawLensOutput>({ prompt: fullPrompt });

  const findings = (result.findings ?? []).map<Finding>((f) => ({
    path: f.path,
    line: typeof f.line === "string" ? Number(f.line) || 0 : (f.line ?? 0),
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
