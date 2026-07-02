import { describe, test, expect } from "bun:test";
import { extractInlineComments } from "../src/verdict/inline-comments.ts";
import { buildErroredLensReport, type LensReport } from "../src/lenses/types.ts";
import type { Verdict } from "../src/verdict/types.ts";

function lens(name: string, findings: LensReport["findings"]): LensReport {
  return { lens: name, summary: "", findings, durationMs: 0 };
}

function verdict(lenses: LensReport[]): Verdict {
  return { decision: "commented", summary: "", lenses };
}

describe("extractInlineComments (compass#99 F15)", () => {
  test("maps line-anchored findings to path/line/body inline comments", () => {
    const v = verdict([
      lens("CodeQuality", [
        {
          path: "src/x.ts",
          line: 12,
          severity: "blocker",
          title: "off-by-one",
          rationale: "loop reads one past the array end",
        },
      ]),
    ]);

    const comments = extractInlineComments(v);
    expect(comments).toEqual([
      {
        path: "src/x.ts",
        line: 12,
        body: expect.stringContaining("off-by-one"),
      },
    ]);
    expect(comments[0]!.body).toContain("loop reads one past the array end");
  });

  test("includes the suggestion in the comment body when present", () => {
    const v = verdict([
      lens("CodeQuality", [
        {
          path: "src/x.ts",
          line: 5,
          severity: "nit",
          title: "unused import",
          rationale: "never referenced",
          suggestion: "remove the import",
        },
      ]),
    ]);

    const comments = extractInlineComments(v);
    expect(comments[0]!.body).toContain("remove the import");
  });

  test("excludes file-level findings (line: 0)", () => {
    const v = verdict([
      lens("CodeQuality", [
        {
          path: "src/x.ts",
          line: 0,
          severity: "suggestion",
          title: "file-level observation",
          rationale: "whole-file concern",
        },
      ]),
    ]);

    expect(extractInlineComments(v)).toEqual([]);
  });

  test("excludes errored-lens synthetic diagnostics", () => {
    const errored = buildErroredLensReport({
      lens: "Security",
      rationale: "substrate timed out",
      durationMs: 10,
      source: "runtime",
    });
    const v = verdict([errored]);

    expect(extractInlineComments(v)).toEqual([]);
  });

  test("multiple lenses, multiple findings — order follows verdict.lenses order", () => {
    const v = verdict([
      lens("CodeQuality", [
        { path: "a.ts", line: 1, severity: "nit", title: "a", rationale: "r" },
      ]),
      lens("Security", [
        { path: "b.ts", line: 2, severity: "blocker", title: "b", rationale: "r" },
      ]),
    ]);

    expect(extractInlineComments(v).map((c) => c.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("no findings → empty comment list", () => {
    const v = verdict([lens("CodeQuality", [])]);
    expect(extractInlineComments(v)).toEqual([]);
  });
});
