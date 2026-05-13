import type { PrMetadata } from "../github/gh.ts";
import { runPiJson } from "../pi/runner.ts";
import type { Finding, LensReport } from "./types.ts";

/**
 * Shared scaffolding for all lenses. Each concrete lens supplies a name,
 * a focus paragraph that goes into the prompt, and an optional set of
 * trigger predicates. Output JSON contract is shared.
 */

export interface LensSpec {
  /** Display name (also returned in LensReport.lens). */
  name: string;
  /**
   * One-paragraph focus statement injected into the prompt. Tells the
   * model what this specific lens is looking for and what counts as a
   * finding versus what's out of scope.
   */
  focus: string;
}

export interface LensRunInput {
  pr: PrMetadata;
  diff: string;
  timeoutMs?: number;
}

interface RawLensOutput {
  summary: string;
  findings: Array<Partial<Finding> & { path: string; line: number | string; title: string }>;
}

const COMMON_INSTRUCTION = (lens: LensSpec) => `You are Sage, a senior code reviewer in the metafactory ecosystem. You are
running the ${lens.name} lens.

LENS FOCUS:
${lens.focus}

CRITICAL OUTPUT CONTRACT: your response MUST be a single JSON object. The
first character of your response MUST be \`{\` and the last character MUST
be \`}\`. No preamble, no postamble, no markdown fences, no prose. Anything
else breaks the downstream parser.

JSON shape:

{
  "summary": "<2-3 sentence high-level take, framed by this lens>",
  "findings": [
    {
      "path": "<file path>",
      "line": <int>,
      "severity": "blocker" | "important" | "suggestion" | "nit",
      "title": "<short headline>",
      "rationale": "<why this matters for THIS lens, 1-3 sentences>",
      "suggestion": "<optional concrete fix>"
    }
  ]
}

Severity rules:
- blocker:    code is incorrect, unsafe, or breaks contracts. Merging would cause harm.
- important:  the change works but degrades quality in a way that warrants change before merge.
- suggestion: optional improvement.
- nit:        cosmetic.

Surface only real issues for THIS lens. Findings that belong to a different
lens are out of scope — skip them. An empty findings array is a valid response.
PR data follows on stdin.`;

const SEVERITY_VALUES = ["blocker", "important", "suggestion", "nit"] as const;
const SEVERITY_SET = new Set<string>(SEVERITY_VALUES);

function normalizeSeverity(raw: unknown): Finding["severity"] {
  if (typeof raw !== "string") return "suggestion";
  const lower = raw.trim().toLowerCase();
  if (SEVERITY_SET.has(lower)) return lower as Finding["severity"];
  // eslint-disable-next-line no-console
  console.error(`[sage] unknown severity from LLM: "${raw}" — defaulting to "suggestion"`);
  return "suggestion";
}

function normalizeLine(raw: number | string | undefined): number {
  if (raw === undefined || raw === null) return 0;
  const parsed = typeof raw === "string" ? parseInt(raw, 10) : raw;
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  return parsed;
}

function buildStdinContent(pr: PrMetadata, diff: string): string {
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

${diff}`;
}

/**
 * Run a lens against a PR. The orchestration (gh fetch, lens loop, verdict)
 * lives in `workflow.ts`; this function is the per-lens execution kernel.
 */
export async function runLens(spec: LensSpec, input: LensRunInput): Promise<LensReport> {
  const started = Date.now();
  const stdinContent = buildStdinContent(input.pr, input.diff);

  let lensResult: { result: RawLensOutput; raw: { stdout: string } } | undefined;
  let extractionError = "";

  try {
    lensResult = await runPiJson<RawLensOutput>({
      // System-role prompt for the JSON contract + lens focus. Models obey
      // system-role instructions more strictly than user messages.
      systemPrompt: COMMON_INSTRUCTION(spec),
      // User message: terse trigger; the actual PR content lives on stdin.
      prompt: "Review the PR data on stdin and respond with the lens JSON.",
      stdin: stdinContent,
      // Disable chain-of-thought reasoning. The trace is ALWAYS prose,
      // and weaker models will emit the trace + NOTHING ELSE, leaving
      // zero JSON to parse. `off` eliminates that failure mode at the
      // source.
      thinking: "off",
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  } catch (err) {
    extractionError = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[sage] ${spec.name} lens JSON extraction failed — falling back to prose finding`);
  }

  // Prose-fallback: model produced output but extractJson couldn't parse it.
  // Rather than crashing the whole review, ship the raw output back as a
  // single `nit` finding. The operator still sees the model's analysis on
  // the PR, and downstream lenses keep firing.
  if (!lensResult) {
    return {
      lens: spec.name,
      summary: "Model output did not match the JSON contract; raw text captured below.",
      findings: [
        {
          path: "(lens output)",
          line: 0,
          severity: "nit",
          title: `${spec.name}: model deviated from JSON contract`,
          rationale: truncate(extractionError, 4000),
        },
      ],
      durationMs: Date.now() - started,
    };
  }

  const findings = (lensResult.result.findings ?? []).map<Finding>((f) => ({
    path: f.path,
    line: normalizeLine(f.line),
    severity: normalizeSeverity(f.severity),
    title: f.title,
    rationale: f.rationale ?? "",
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
  }));
  void extractionError;

  return {
    lens: spec.name,
    summary: lensResult.result.summary ?? "",
    findings,
    durationMs: Date.now() - started,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[…truncated ${s.length - max} chars]`;
}
