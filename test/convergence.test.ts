import { describe, expect, test } from "bun:test";
import type { LensReport } from "../src/lenses/types.ts";
import {
  addedLinesByPath,
  decideVerdict,
  markPreviousRoundSurface,
  renderVerdict,
} from "../src/verdict/index.ts";

function lens(findings: LensReport["findings"]): LensReport {
  return { lens: "CodeQuality", summary: "", findings, durationMs: 0 };
}

describe("sage#107 convergence signal", () => {
  test("reports the per-round impact split and makes prose-only rounds explicit", () => {
    const verdict = decideVerdict([
      lens([
        { path: "README.md", line: 4, severity: "important", impact: "prose", title: "Duplicated sentence", rationale: "The added text repeats itself." },
      ]),
    ]);

    expect(verdict.convergence).toEqual({
      behavior: 0,
      check: 0,
      prose: 1,
      unclassifiedImpact: 0,
      previousRoundSurface: 0,
      coverageFailed: false,
      status: "prose-only",
    });
    expect(renderVerdict(verdict)).toContain("changes-requested (prose only)");
    expect(renderVerdict(verdict)).toContain("an autonomous loop may stop");
  });

  test("keeps legacy model findings conservative and treats broken coverage as actionable", () => {
    const legacy = decideVerdict([
      lens([{ path: "src/a.ts", line: 2, severity: "suggestion", title: "Legacy", rationale: "No impact field." }]),
    ]);
    expect(legacy.convergence?.status).toBe("actionable");
    expect(legacy.convergence?.unclassifiedImpact).toBe(1);
    expect(renderVerdict(legacy)).toContain("unclassified impact 1");

    const errored: LensReport = { lens: "Security", summary: "", findings: [], durationMs: 0, errored: true };
    expect(decideVerdict([errored]).convergence?.status).toBe("actionable");
  });

  test("marks only lines introduced since the previous Sage review", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@",
      " keep();",
      "+newLine();",
      " replace();",
    ].join("\n");
    const marked = markPreviousRoundSurface(
      [lens([
        { path: "src/a.ts", line: 11, severity: "nit", impact: "prose", title: "New", rationale: "x" },
        { path: "src/a.ts", line: 12, severity: "nit", impact: "prose", title: "Old", rationale: "x" },
      ])],
      addedLinesByPath(diff),
    );
    expect(marked[0]?.findings[0]?.previousRoundSurface).toBe(true);
    expect(marked[0]?.findings[1]?.previousRoundSurface).toBeUndefined();
  });
});
