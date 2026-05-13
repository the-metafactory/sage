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
});
