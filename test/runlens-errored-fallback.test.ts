import { describe, expect, test } from "bun:test";
import { runLens, type LensRunInput } from "../src/lenses/base.ts";
import type { Substrate } from "../src/substrate/types.ts";

/**
 * sage#27 Holly re-review (finding #1): `runLens`'s substrate-fallback
 * branch — fires when `substrate.runJson` throws or the model output
 * can't be parsed as JSON — emits `errored: true` and severity
 * `important`. Pre-fix it emitted severity `nit` and no errored flag,
 * which left the dominant in-production failure mode silently
 * mergable.
 *
 * The running daemon's err.log shows this branch firing as
 * `CodeQuality lens JSON extraction failed — falling back to prose
 * finding` — three lenses in a recent task hit it on a single PR.
 */

const stubPr = {
  number: 1,
  title: "t",
  body: "",
  state: "open",
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

function makeFailingSubstrate(message: string): Substrate {
  return {
    name: "pi" as const,
    displayName: "pi.dev",
    bin: "pi",
    run: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 }),
    runJson: async () => {
      throw new Error(message);
    },
  };
}

const input = (substrate: Substrate): LensRunInput => ({
  pr: stubPr,
  diff: "diff",
  substrate,
});

describe("runLens substrate-failure fallback (sage#27 Holly round 2 #1)", () => {
  test("sets errored: true", async () => {
    const report = await runLens(
      { name: "CodeQuality", focus: "x" },
      input(makeFailingSubstrate("pi unreachable")),
    );
    expect(report.errored).toBe(true);
  });

  test("emits severity 'important' (NOT 'nit')", async () => {
    const report = await runLens(
      { name: "Security", focus: "x" },
      input(makeFailingSubstrate("pi 500")),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].severity).toBe("important");
  });

  test("rationale captures the substrate error message", async () => {
    const report = await runLens(
      { name: "Architecture", focus: "x" },
      input(makeFailingSubstrate("auth expired")),
    );
    expect(report.findings[0].rationale).toMatch(/auth expired/);
  });

  test("clean-path run does NOT set errored", async () => {
    const happy: Substrate = {
      name: "pi" as const,
      displayName: "pi.dev",
      bin: "pi",
      run: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 }),
      runJson: async <T>() => ({
        result: { summary: "ok", findings: [] } as unknown as T,
        raw: { stdout: "", stderr: "", exitCode: 0, durationMs: 1 },
      }),
    };
    const report = await runLens(
      { name: "CodeQuality", focus: "x" },
      input(happy),
    );
    expect(report.errored).toBeUndefined();
    expect(report.findings).toHaveLength(0);
  });
});
