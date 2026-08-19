import { describe, expect, test } from "bun:test";
import type { PriorReviewFinding } from "../src/forge/types.ts";
import type { Finding, LensReport } from "../src/lenses/types.ts";
import { decideVerdict, markRepeatedFindings, renderVerdict } from "../src/verdict/index.ts";

/**
 * sage#107 — repeat detection.
 *
 * The lens prompt asks each lens not to re-raise an earlier round's Finding.
 * That holds for verbatim repeats and is walked straight through by rephrasing,
 * which is why seekolous#199's per-round Finding count never converged while
 * its code stopped moving after round 5. A restatement reads as new work to the
 * reviewee, who spends a round on it.
 */

function lens(findings: Finding[], overrides: Partial<LensReport> = {}): LensReport {
  return { lens: "Maintainability", summary: "", findings, durationMs: 0, ...overrides };
}

function finding(over: Partial<Finding> & Pick<Finding, "path" | "title">): Finding {
  return {
    line: 10,
    severity: "important",
    impact: "behavior",
    rationale: "x",
    ...over,
  };
}

function prior(over: Partial<PriorReviewFinding> & Pick<PriorReviewFinding, "path" | "title">): PriorReviewFinding {
  return { line: 4, severity: "important", ...over };
}

describe("sage#107 repeat detection", () => {
  test("marks a verbatim restatement with the earlier round's title", () => {
    const [report] = markRepeatedFindings(
      [lens([finding({ path: "src/a.ts", title: "Duplicated sentence in README" })])],
      [prior({ path: "src/a.ts", title: "Duplicated sentence in README" })],
    );

    expect(report?.findings[0]?.repeatOfPriorFinding).toBe("Duplicated sentence in README");
  });

  test("matches across a rewording", () => {
    const [report] = markRepeatedFindings(
      [lens([finding({ path: "README.md", title: "README sentence is duplicated twice" })])],
      [prior({ path: "README.md", title: "Duplicated sentence in README" })],
    );

    expect(report?.findings[0]?.repeatOfPriorFinding).toBe("Duplicated sentence in README");
  });

  test("line number is not part of the key — the reviewee's fixes shift it every round", () => {
    const [report] = markRepeatedFindings(
      [lens([finding({ path: "src/a.ts", line: 412, title: "Unbounded retry loop" })])],
      [prior({ path: "src/a.ts", line: 87, title: "Unbounded retry loop" })],
    );

    expect(report?.findings[0]?.repeatOfPriorFinding).toBe("Unbounded retry loop");
  });

  test("under-matches rather than over-matches: a heavy paraphrase reads as new", () => {
    // 3 shared tokens out of 7 — below threshold on purpose. Telling a reviewee
    // that genuinely new work is old news is the more expensive mistake.
    const [report] = markRepeatedFindings(
      [lens([finding({ path: "src/a.ts", title: "User input lacks a null check" })])],
      [prior({ path: "src/a.ts", title: "Missing null guard on user input" })],
    );

    expect(report?.findings[0]?.repeatOfPriorFinding).toBeUndefined();
  });

  test("the same title on a different file is a different finding", () => {
    const [report] = markRepeatedFindings(
      [lens([finding({ path: "src/b.ts", title: "Unbounded retry loop" })])],
      [prior({ path: "src/a.ts", title: "Unbounded retry loop" })],
    );

    expect(report?.findings[0]?.repeatOfPriorFinding).toBeUndefined();
  });

  test("no prior findings leaves every finding untouched", () => {
    const input = [lens([finding({ path: "src/a.ts", title: "Unbounded retry loop" })])];
    const [report] = markRepeatedFindings(input, []);

    expect(report?.findings[0]?.repeatOfPriorFinding).toBeUndefined();
    expect(report?.findings[0]).toEqual(input[0]!.findings[0]!);
  });

  test("an errored lens's diagnostic is never marked as a repeat", () => {
    const [report] = markRepeatedFindings(
      [
        lens([finding({ path: "(lens output)", title: "Security: model deviated from JSON contract" })], {
          lens: "Security",
          errored: true,
        }),
      ],
      [prior({ path: "(lens output)", title: "Security: model deviated from JSON contract" })],
    );

    expect(report?.findings[0]?.repeatOfPriorFinding).toBeUndefined();
  });

  test("a marked repeat keeps its severity and its hold on the verdict", () => {
    // The whole reason this marks instead of dropping: a finding that repeats
    // because nobody fixed it is exactly the one that must keep blocking.
    const marked = markRepeatedFindings(
      [lens([finding({ path: "src/a.ts", title: "Unbounded retry loop", severity: "blocker" })])],
      [prior({ path: "src/a.ts", title: "Unbounded retry loop", severity: "blocker" })],
    );
    const verdict = decideVerdict(marked);

    expect(verdict.lenses[0]?.findings[0]?.severity).toBe("blocker");
    expect(verdict.decision).toBe("changes-requested");
  });

  test("convergence counts repeats, and the body names what was restated", () => {
    const marked = markRepeatedFindings(
      [
        lens([
          finding({ path: "src/a.ts", title: "Unbounded retry loop" }),
          finding({ path: "src/a.ts", line: 20, title: "Something genuinely new" }),
        ]),
      ],
      [prior({ path: "src/a.ts", title: "Unbounded retry loop" })],
    );
    const verdict = decideVerdict(marked);

    expect(verdict.convergence?.repeated).toBe(1);
    expect(verdict.convergence?.behavior).toBe(2);
    const body = renderVerdict(verdict);
    expect(body).toContain('_Restates an earlier round: "Unbounded retry loop". Still open._');
    expect(body).toContain("restated from earlier rounds 1");
  });
});
