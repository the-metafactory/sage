import { describe, test, expect } from "bun:test";
import {
  renderVerdictBlock,
  mapFindingsToBuckets,
  type VerdictBlockMeta,
} from "../src/verdict/block.ts";
import type { Verdict } from "../src/verdict/types.ts";
import type { LensReport } from "../src/lenses/types.ts";

function lens(name: string, findings: LensReport["findings"]): LensReport {
  return { lens: name, summary: "", findings, durationMs: 0 };
}

const META: VerdictBlockMeta = {
  github_review_id: 0,
  github_review_url: "",
  submitted_at: "2026-06-10T09:11:36Z",
  commit_id: "deadbeef",
  inline_comments: 0,
};

/**
 * Mirror of cortex's `parseVerdictBlock` field validation
 * (cortex/src/runner/review-pipeline.ts). If this drifts, the round-trip
 * test fails and we know the cortex contract broke.
 */
function extractAndParse(stdout: string): Record<string, unknown> {
  const re = /```json\s*\r?\n([\s\S]*?)\r?\n```/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null = re.exec(stdout);
  while (m !== null) {
    if (m[1] !== undefined) matches.push(m[1]);
    m = re.exec(stdout);
  }
  const raw = matches[matches.length - 1];
  if (raw === undefined) throw new Error("no fenced json block found");
  const obj = JSON.parse(raw) as Record<string, unknown>;

  const verdict = obj.verdict;
  if (verdict !== "approved" && verdict !== "changes-requested" && verdict !== "commented")
    throw new Error(`verdict invalid: ${JSON.stringify(verdict)}`);
  if (typeof obj.summary !== "string") throw new Error("summary must be string");
  if (typeof obj.github_review_id !== "number" || !Number.isInteger(obj.github_review_id))
    throw new Error("github_review_id must be integer");
  if (typeof obj.github_review_url !== "string") throw new Error("github_review_url must be string");
  if (typeof obj.submitted_at !== "string") throw new Error("submitted_at must be string");
  if (typeof obj.commit_id !== "string") throw new Error("commit_id must be string");
  if (typeof obj.inline_comments !== "number" || !Number.isInteger(obj.inline_comments))
    throw new Error("inline_comments must be integer");
  if (typeof obj.findings !== "object" || obj.findings === null || Array.isArray(obj.findings))
    throw new Error("findings must be object");
  const f = obj.findings as Record<string, unknown>;
  for (const k of ["blockers", "majors", "nits"]) {
    if (typeof f[k] !== "number" || !Number.isInteger(f[k]))
      throw new Error(`findings.${k} must be integer`);
  }
  return obj;
}

describe("mapFindingsToBuckets", () => {
  test("blocker → blockers, important → majors, suggestion + nit → nits", () => {
    const v: Verdict = {
      decision: "changes-requested",
      summary: "x",
      lenses: [
        lens("L", [
          { path: "a", line: 1, severity: "blocker", title: "t", rationale: "r" },
          { path: "b", line: 2, severity: "important", title: "t", rationale: "r" },
          { path: "c", line: 3, severity: "important", title: "t", rationale: "r" },
          { path: "d", line: 4, severity: "suggestion", title: "t", rationale: "r" },
          { path: "e", line: 5, severity: "nit", title: "t", rationale: "r" },
          { path: "f", line: 6, severity: "nit", title: "t", rationale: "r" },
        ]),
      ],
    };
    expect(mapFindingsToBuckets(v)).toEqual({ blockers: 1, majors: 2, nits: 3 });
  });

  test("zero findings → all zero", () => {
    const v: Verdict = { decision: "approved", summary: "x", lenses: [lens("L", [])] };
    expect(mapFindingsToBuckets(v)).toEqual({ blockers: 0, majors: 0, nits: 0 });
  });

  test("errored lens with no findings contributes nothing", () => {
    const v: Verdict = {
      decision: "changes-requested",
      summary: "x",
      lenses: [{ lens: "L", summary: "", findings: [], durationMs: 0, errored: true }],
    };
    expect(mapFindingsToBuckets(v)).toEqual({ blockers: 0, majors: 0, nits: 0 });
  });
});

describe("renderVerdictBlock", () => {
  test("emits a single fenced json block ending the output", () => {
    const v: Verdict = { decision: "approved", summary: "ok", lenses: [lens("L", [])] };
    const out = renderVerdictBlock(v, META);
    expect(out).toMatch(/```json\n/);
    expect(out.trim().endsWith("```")).toBe(true);
  });

  test("verdict field equals decision verbatim", () => {
    for (const decision of ["approved", "changes-requested", "commented"] as const) {
      const v: Verdict = { decision, summary: "s", lenses: [lens("L", [])] };
      const parsed = extractAndParse(renderVerdictBlock(v, META));
      expect(parsed.verdict).toBe(decision);
    }
  });

  test("round-trips cortex parseVerdictBlock contract", () => {
    const v: Verdict = {
      decision: "changes-requested",
      summary: "2 finding(s): 1 blocker, 1 nit.",
      lenses: [
        lens("Security", [
          { path: "a", line: 1, severity: "blocker", title: "t", rationale: "r" },
          { path: "b", line: 2, severity: "nit", title: "t", rationale: "r" },
        ]),
      ],
    };
    const meta: VerdictBlockMeta = {
      github_review_id: 12345,
      github_review_url: "https://github.com/o/r/pull/1#pullrequestreview-12345",
      submitted_at: "2026-06-10T09:11:36Z",
      commit_id: "abc1234",
      inline_comments: 0,
    };
    const parsed = extractAndParse(renderVerdictBlock(v, meta));
    expect(parsed.verdict).toBe("changes-requested");
    expect(parsed.github_review_id).toBe(12345);
    expect(parsed.commit_id).toBe("abc1234");
    expect(parsed.findings).toEqual({ blockers: 1, majors: 0, nits: 1 });
  });

  test("the block is the LAST json fence so cortex picks it over body fences", () => {
    const v: Verdict = { decision: "commented", summary: "s", lenses: [lens("L", [])] };
    const body = "## Sage review\n\n```json\n{\"scratch\": true}\n```\n";
    const full = body + "\n" + renderVerdictBlock(v, META);
    const parsed = extractAndParse(full);
    expect(parsed.summary).toBe("s");
  });
});
