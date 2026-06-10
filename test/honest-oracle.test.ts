/**
 * Honest Oracle lens — the adversary is not the fixer.
 *
 * The focus prompt asks the model to omit `suggestion`, but the lens ALSO
 * strips it structurally so the indictment-only contract holds even when the
 * model drifts and emits a remedy. This test drives a stub substrate that
 * returns a finding WITH a suggestion and asserts the lens removes it.
 */

import { describe, test, expect } from "bun:test";
import { reviewHonestOracle } from "../src/lenses/honest-oracle.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/index.ts";
import type { Substrate } from "../src/substrate/types.ts";

function substrateReturning(json: unknown): Substrate {
  return {
    name: "pi",
    displayName: "pi.dev",
    bin: "pi",
    jsonExtractors: TEXT_EXTRACTORS,
    envRequirements: { namespaces: [], keys: [] },
    run: async () => ({ stdout: JSON.stringify(json), stderr: "", exitCode: 0, durationMs: 1 }),
  };
}

const pr = {
  number: 1,
  title: "t",
  body: "This PR claims to fully fix everything and is guaranteed complete.",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "f",
  author: { login: "a" },
  changedFiles: 1,
  additions: 1,
  deletions: 0,
  files: [{ path: "a.ts", additions: 1, deletions: 0 }],
  url: "https://github.com/x/y/pull/1",
};

describe("reviewHonestOracle", () => {
  test("strips the suggestion field even when the model emits one", async () => {
    const substrate = substrateReturning({
      summary: "Overclaim in the description.",
      findings: [
        {
          path: "a.ts",
          line: 0,
          severity: "important",
          title: "'fully fix everything' is unsupported by a 1-line diff",
          rationale: "The description claims a complete fix; the diff is one line.",
          suggestion: "qualify the claim", // model drifted and added a remedy
        },
      ],
    });

    const report = await reviewHonestOracle({ pr, diff: "+x", substrate });

    expect(report.lens).toBe("HonestOracle");
    expect(report.findings.length).toBe(1);
    expect(report.findings[0]!.title).toContain("unsupported");
    // The adversary's output is the indictment, never the remedy.
    expect(report.findings[0]!.suggestion).toBeUndefined();
  });

  test("passes through a clean (no-suggestion) finding unchanged", async () => {
    const substrate = substrateReturning({
      summary: "One overclaim.",
      findings: [{ path: "a.ts", line: 0, severity: "blocker", title: "overclaim", rationale: "why" }],
    });
    const report = await reviewHonestOracle({ pr, diff: "+x", substrate });
    expect(report.findings[0]!.suggestion).toBeUndefined();
    expect(report.findings[0]!.severity).toBe("blocker");
  });
});
