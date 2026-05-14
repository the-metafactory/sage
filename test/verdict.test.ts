import { describe, test, expect } from "bun:test";
import { decideVerdict, type LensReport } from "../src/lenses/types.ts";

function lens(name: string, findings: LensReport["findings"]): LensReport {
  return { lens: name, summary: "", findings, durationMs: 0 };
}

describe("decideVerdict", () => {
  test("no findings → approved", () => {
    const v = decideVerdict([lens("CodeQuality", [])]);
    expect(v.decision).toBe("approved");
  });

  test("only nit/suggestion → commented", () => {
    const v = decideVerdict([
      lens("CodeQuality", [
        { path: "a.ts", line: 1, severity: "nit", title: "t", rationale: "r" },
        { path: "b.ts", line: 2, severity: "suggestion", title: "t", rationale: "r" },
      ]),
    ]);
    expect(v.decision).toBe("commented");
  });

  test("any important → changes-requested", () => {
    const v = decideVerdict([
      lens("CodeQuality", [
        { path: "a.ts", line: 1, severity: "important", title: "t", rationale: "r" },
      ]),
    ]);
    expect(v.decision).toBe("changes-requested");
  });

  test("important alongside suggestion → changes-requested", () => {
    const v = decideVerdict([
      lens("CodeQuality", [
        { path: "a.ts", line: 1, severity: "important", title: "t", rationale: "r" },
        { path: "b.ts", line: 2, severity: "suggestion", title: "t", rationale: "r" },
      ]),
    ]);
    expect(v.decision).toBe("changes-requested");
  });

  test("any blocker → changes-requested", () => {
    const v = decideVerdict([
      lens("CodeQuality", [
        { path: "a.ts", line: 1, severity: "suggestion", title: "t", rationale: "r" },
        { path: "b.ts", line: 2, severity: "blocker", title: "t", rationale: "r" },
      ]),
    ]);
    expect(v.decision).toBe("changes-requested");
  });

  test("blocker dominates regardless of other findings", () => {
    const v = decideVerdict([
      lens("CodeQuality", []),
      lens("Security", [
        { path: "x", line: 0, severity: "blocker", title: "t", rationale: "r" },
      ]),
      lens("Architecture", [
        { path: "y", line: 0, severity: "nit", title: "t", rationale: "r" },
      ]),
    ]);
    expect(v.decision).toBe("changes-requested");
  });

  test("summary counts findings by severity when present", () => {
    const v = decideVerdict([
      lens("CodeQuality", [
        { path: "a", line: 1, severity: "important", title: "t", rationale: "r" },
        { path: "b", line: 2, severity: "suggestion", title: "t", rationale: "r" },
        { path: "c", line: 3, severity: "suggestion", title: "t", rationale: "r" },
        { path: "d", line: 4, severity: "nit", title: "t", rationale: "r" },
      ]),
    ]);
    expect(v.summary).toMatch(/4 finding/);
    expect(v.summary).toMatch(/1 important/);
    expect(v.summary).toMatch(/2 suggestion/);
    expect(v.summary).toMatch(/1 nit/);
  });

  // Holly review of sage#27 (findings #1 + #2): a lens that errored
  // before producing real findings blocks merge. Its absence is the
  // signal — we don't know what the lens would have flagged.
  describe("errored lens (sage#27 Holly review)", () => {
    function erroredLens(name: string): LensReport {
      return {
        lens: name,
        summary: "lens did not run",
        findings: [],
        durationMs: 0,
        errored: true,
      };
    }

    test("errored lens with no findings → changes-requested, not approved", () => {
      const v = decideVerdict([
        lens("CodeQuality", []),
        erroredLens("Security"),
      ]);
      expect(v.decision).toBe("changes-requested");
    });

    test("errored lens summary names the failed lens", () => {
      const v = decideVerdict([
        lens("CodeQuality", []),
        erroredLens("Security"),
      ]);
      expect(v.summary).toMatch(/lens\(es\) failed to run: Security/);
    });

    test("multiple errored lenses all named in summary", () => {
      const v = decideVerdict([
        lens("CodeQuality", []),
        erroredLens("Security"),
        erroredLens("Performance"),
      ]);
      expect(v.summary).toMatch(/Security/);
      expect(v.summary).toMatch(/Performance/);
      expect(v.summary).toMatch(/2 lens\(es\)/);
    });

    test("errored lens combined with real findings — both surface in summary", () => {
      const v = decideVerdict([
        lens("CodeQuality", [
          { path: "a", line: 1, severity: "suggestion", title: "t", rationale: "r" },
        ]),
        erroredLens("Security"),
      ]);
      expect(v.decision).toBe("changes-requested");
      expect(v.summary).toMatch(/1 finding/);
      expect(v.summary).toMatch(/Security/);
    });

    test("all-clean run stays byte-stable in the summary text", () => {
      // The pre-#27 "No findings. Sage approves." string is part of
      // the operator-facing review body; on-disk verdict JSON is
      // already pinned by other tests. Sanity-check that adding the
      // errored branch didn't perturb the clean-path summary.
      const v = decideVerdict([lens("CodeQuality", [])]);
      expect(v.summary).toBe("No findings. Sage approves.");
    });
  });
});
