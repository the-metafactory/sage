import { describe, test, expect } from "bun:test";
import { describeClaudeRefusal } from "../src/substrate/claude.ts";
import { buildErroredLensReport, type LensReport } from "../src/lenses/types.ts";
import { decideVerdict } from "../src/verdict/index.ts";

/**
 * sage#104 — the Architecture and ContextDrift lenses failed on every soma
 * review round for months, reported as "model deviated from JSON contract".
 * The model had never run: a `UserPromptSubmit` policy hook on the operator's
 * machine denied the lens prompt, and Claude Code reported that denial as a
 * *successful* run whose `result` was the denial notice.
 */

// The real envelope, captured from `claude -p` during the diagnosis.
const REFUSAL_ENVELOPE = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  duration_ms: 353,
  result: "Operation stopped by hook: Runtime policy denied this action: security-disable-request.",
};

describe("substrate refusal detection", () => {
  test("a hook denial is recognised as a refusal, not a contract deviation", () => {
    const reason = describeClaudeRefusal(REFUSAL_ENVELOPE);
    expect(reason).toBeDefined();
    // The operator has to be able to act on this: name the hook and the rule.
    expect(reason).toContain("num_turns: 0");
    expect(reason).toContain("Operation stopped by hook");
    expect(reason).toContain("security-disable-request");
  });

  test("a real answer in the wrong shape is NOT a refusal", () => {
    // The model ran and replied — that genuinely is a contract deviation, and
    // must keep its old diagnosis rather than being excused as infrastructure.
    expect(
      describeClaudeRefusal({ type: "result", subtype: "success", num_turns: 3, result: "here you go" }),
    ).toBeUndefined();
    expect(describeClaudeRefusal({ summary: "fine", findings: [] })).toBeUndefined();
    expect(describeClaudeRefusal("not an object")).toBeUndefined();
    expect(describeClaudeRefusal(null)).toBeUndefined();
  });

  test("a refused lens says the model never ran", () => {
    const report = buildErroredLensReport({
      lens: "Architecture",
      rationale: describeClaudeRefusal(REFUSAL_ENVELOPE) ?? "",
      durationMs: 1,
      source: "refused",
    });
    expect(report.errored).toBe(true);
    expect(report.findings[0].title).toContain("the model never ran");
    expect(report.findings[0].title).not.toContain("deviated");
    expect(report.findings[0].infrastructure).toBe(true);
  });
});

describe("infrastructure findings are not code findings", () => {
  function lens(name: string, findings: LensReport["findings"]): LensReport {
    return { lens: name, summary: "", findings, durationMs: 0 };
  }

  const refused = buildErroredLensReport({
    lens: "Architecture",
    rationale: "refused",
    durationMs: 1,
    source: "refused",
  });

  test("a broken lens no longer inflates the code-finding counts", () => {
    const verdict = decideVerdict([
      refused,
      lens("CodeQuality", [
        { path: "a.ts", line: 1, severity: "suggestion", title: "s", rationale: "r" },
      ]),
    ]);

    // Before: "2 finding(s): 1 important, 1 suggestion" — the "important" was
    // the crash, and a reader reasonably concluded the PR had a quality problem.
    expect(verdict.summary).toContain("1 finding(s)");
    expect(verdict.summary).not.toContain("important");
    expect(verdict.summary).toContain("1 lens(es) failed to run: Architecture");
  });

  test("the verdict still blocks — coverage is incomplete, which is the honest reason", () => {
    // Excluding infrastructure findings from the counts must never become a path
    // to approving a PR whose lenses never ran.
    expect(decideVerdict([refused]).decision).toBe("changes-requested");
    expect(
      decideVerdict([
        refused,
        lens("CodeQuality", []),
      ]).decision,
    ).toBe("changes-requested");
  });

  test("a clean review with every lens running still approves", () => {
    expect(decideVerdict([lens("CodeQuality", []), lens("Security", [])]).decision).toBe("approved");
  });

  test("real important findings still request changes", () => {
    const verdict = decideVerdict([
      lens("CodeQuality", [
        { path: "a.ts", line: 1, severity: "important", title: "i", rationale: "r" },
      ]),
    ]);
    expect(verdict.decision).toBe("changes-requested");
    expect(verdict.summary).toContain("1 important");
  });
});
