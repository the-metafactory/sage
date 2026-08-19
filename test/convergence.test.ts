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
      repeated: 0,
      previousRoundSurfaceUnavailable: false,
      coverageFailed: false,
      status: "prose-only",
    });
    // An `important` finding that changes only wording no longer returns
    // changes-requested. That is the point: the round is reported honestly AND
    // stops blocking, so an autonomous loop terminates without an operator
    // deciding to override it.
    expect(verdict.decision).toBe("commented");
    expect(renderVerdict(verdict)).toContain("commented (prose only)");
    expect(renderVerdict(verdict)).toContain("an autonomous loop may stop");
  });

  test("keeps legacy model findings conservative and treats broken coverage as actionable", () => {
    const legacy = decideVerdict([
      lens([{ path: "src/a.ts", line: 2, severity: "suggestion", title: "Legacy", rationale: "No impact field." }]),
    ]);
    expect(legacy.convergence?.status).toBe("actionable");
    expect(legacy.convergence?.unclassifiedImpact).toBe(1);
    expect(renderVerdict(legacy)).toContain("unclassified impact 1");

    const unavailable = decideVerdict([
      { ...lens([{ path: "README.md", line: 4, severity: "nit", impact: "prose", title: "Wording", rationale: "Text only." }]), previousRoundSurfaceUnavailable: true },
    ]);
    expect(unavailable.convergence?.status).toBe("actionable");
    expect(renderVerdict(unavailable)).toContain("Prior-round surface coverage is unavailable.");

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
  test("important blocks at behavior or check impact, not at prose", () => {
    for (const impact of ["behavior", "check"] as const) {
      const verdict = decideVerdict([
        lens([{ path: "src/a.ts", line: 3, severity: "important", impact, title: "Real", rationale: "x" }]),
      ]);
      expect(verdict.decision).toBe("changes-requested");
    }

    const prose = decideVerdict([
      lens([{ path: "src/a.ts", line: 3, severity: "important", impact: "prose", title: "Wording", rationale: "x" }]),
    ]);
    expect(prose.decision).toBe("commented");
  });

  test("blocker still blocks at prose impact", () => {
    const verdict = decideVerdict([
      lens([
        { path: "README.md", line: 9, severity: "blocker", impact: "prose", title: "Claims encryption the code lacks", rationale: "x" },
      ]),
    ]);
    expect(verdict.decision).toBe("changes-requested");
  });

  test("an unclassified impact keeps blocking", () => {
    const missing = decideVerdict([
      lens([{ path: "src/a.ts", line: 3, severity: "important", title: "No impact field", rationale: "x" }]),
    ]);
    expect(missing.decision).toBe("changes-requested");

    const fallback = decideVerdict([
      lens([
        { path: "src/a.ts", line: 3, severity: "important", impact: "prose", impactFallback: true, title: "Defaulted", rationale: "x" },
      ]),
    ]);
    expect(fallback.decision).toBe("changes-requested");
  });

  test("an errored lens still blocks under the impact gate", () => {
    const errored: LensReport = {
      lens: "Security",
      summary: "",
      findings: [
        { path: "(lens output)", line: 0, severity: "important", title: "Security: model deviated from JSON contract", rationale: "x" },
      ],
      durationMs: 0,
      errored: true,
    };
    expect(decideVerdict([errored]).decision).toBe("changes-requested");
  });

  test("prose findings on previous-round surface are capped at nit", () => {
    const verdict = decideVerdict([
      lens([
        { path: "src/a.ts", line: 3, severity: "important", impact: "prose", previousRoundSurface: true, title: "Comment repeats itself", rationale: "x" },
        { path: "src/a.ts", line: 4, severity: "suggestion", impact: "prose", previousRoundSurface: true, title: "Wordy", rationale: "x" },
      ]),
    ]);
    expect(verdict.lenses[0]?.findings.map((f) => f.severity)).toEqual(["nit", "nit"]);
    expect(verdict.decision).toBe("commented");
  });

  test("the cap spares blocker, behavior/check impact, fallbacks, and untouched surface", () => {
    const verdict = decideVerdict([
      lens([
        { path: "src/a.ts", line: 3, severity: "blocker", impact: "prose", previousRoundSurface: true, title: "Misleading claim", rationale: "x" },
        { path: "src/a.ts", line: 4, severity: "important", impact: "check", previousRoundSurface: true, title: "Regression test cannot fail", rationale: "x" },
        { path: "src/a.ts", line: 5, severity: "important", impact: "prose", impactFallback: true, previousRoundSurface: true, title: "Defaulted impact", rationale: "x" },
        { path: "src/a.ts", line: 6, severity: "important", impact: "prose", title: "Not previous-round surface", rationale: "x" },
      ]),
    ]);
    expect(verdict.lenses[0]?.findings.map((f) => f.severity)).toEqual([
      "blocker",
      "important",
      "important",
      "important",
    ]);
    expect(verdict.decision).toBe("changes-requested");
  });
});
