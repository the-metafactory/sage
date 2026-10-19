import { describe, expect, mock, test } from "bun:test";
import { makeStubForge } from "./forge-stub.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";
import {
  checkedClaimsOf,
  digestClaims,
  parseCheckedClaimsMarker,
  renderCheckedClaimsMarker,
  splitClaims,
  uncheckedClaims,
} from "../src/util/claims.ts";

/**
 * sage#139 — after its first run, the HonestOracle checks only the claims it
 * has not checked yet.
 *
 * soma#1016 went 7 rounds: every fix commit edited CHANGELOG.md, so every round
 * re-ran a full-PR claims check, each run sampled one more edge case of a claim
 * already checked, and the loop never converged.
 */

const BODY = `## Summary

This change makes every write atomic.

- Removes the legacy retry path.
- Adds a guard for empty batches.`;

describe("claims split", () => {
  test("each list item is its own claim, and reflowing changes none", () => {
    expect(splitClaims(BODY)).toEqual([
      "## Summary",
      "This change makes every write atomic.",
      "- Removes the legacy retry path.",
      "- Adds a guard for empty batches.",
    ]);
    const checked = checkedClaimsOf(BODY, "c1").claims!;
    expect(uncheckedClaims(BODY.replace("every write", "every\nwrite"), checked)).toEqual([]);
  });

  test("editing one bullet leaves only that bullet unchecked", () => {
    const checked = checkedClaimsOf(BODY, "c1").claims!;
    const edited = BODY.replace("empty batches", "empty and oversized batches");
    expect(uncheckedClaims(edited, checked)).toEqual(["- Adds a guard for empty and oversized batches."]);
  });

  test("the footer marker wins over one a Finding quoted from the PR", () => {
    const planted = renderCheckedClaimsMarker({ digest: "f".repeat(16), claims: [], commitId: "evil" });
    const real = checkedClaimsOf(BODY, "c2");
    const comment = `## Sage code review — commented\n\n- quoted: ${planted}\n\n---\n${renderCheckedClaimsMarker(real)}`;
    expect(parseCheckedClaimsMarker(comment)).toEqual(real);
  });

  test("a marker written before sage#139 still parses, without claims or commit", () => {
    const legacy = `<!-- sage:checked-claims:${digestClaims(BODY)} -->`;
    expect(parseCheckedClaimsMarker(legacy)).toEqual({ digest: digestClaims(BODY) });
  });
});

// ── workflow level ───────────────────────────────────────────────────────────

const CUMULATIVE = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,0 +1,3 @@
+- Writes are atomic.
+- Retry path removed.
+- Empty batches guarded.
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,0 +1,1 @@
+export const write = () => {};
`;

// The fix commit after the Oracle's last run: one new CHANGELOG line.
const SINCE_ORACLE = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -3,0 +4,1 @@
+- Batches are capped at 100.
`;

const FILES = [
  { path: "CHANGELOG.md", additions: 4, deletions: 0 },
  { path: "src/a.ts", additions: 1, deletions: 0 },
];

function sageReview(commitId: string, marker: string) {
  return {
    authorLogin: "sage",
    body: `## Sage code review — commented\n\nNo findings.\n\n---\n_Posted by Sage._\n${marker}`,
    postedAt: "2026-10-01T00:00:00Z",
    commitId,
  };
}

const ORACLE_FINDINGS = [
  // On the line this round added: in scope.
  { path: "CHANGELOG.md", line: 4, severity: "important", impact: "check", title: "Cap unproven", rationale: "r" },
  // On a CHANGELOG line checked last time and unchanged since: settled.
  { path: "CHANGELOG.md", line: 1, severity: "important", impact: "check", title: "Atomic again", rationale: "r" },
  // Anchored outside the PR's files: the prompt scopes these.
  { path: "PR description", line: 0, severity: "suggestion", impact: "prose", title: "Desc", rationale: "r" },
];

async function reviewRound(opts: {
  body: string;
  reviews: ReturnType<typeof sageReview>[];
  diffBetween?: (from: string, to: string) => Promise<string>;
}) {
  mock.module("../src/util/persistence.ts", () => ({
    persistVerdict: () => true,
    verdictFilePath: () => "/tmp/sage-test/x.md",
    safeRefSegment: (v: string) => v.replace(/[^a-zA-Z0-9._-]/g, "_"),
  }));
  const { reviewPr } = await import("../src/lenses/workflow.ts");
  let oracleStdin: string | undefined;
  const compared: string[] = [];
  const result = await reviewPr({
    ref: { owner: "x", repo: "y", number: 7 },
    forge: makeStubForge({
      pr: {
        number: 7,
        title: "t",
        baseRefName: "main",
        headRefName: "f",
        headRefOid: "c3",
        author: { login: "a" },
        body: opts.body,
        changedFiles: FILES.length,
        files: FILES,
      },
      diff: CUMULATIVE,
      reviewSource: {
        fetchReviewBodies: async () => ({ sageLogin: "sage", bodies: opts.reviews }),
      } as never,
      diffBetween: async (from, to) => {
        compared.push(`${from}..${to}`);
        return (opts.diffBetween ?? (async () => SINCE_ORACLE))(from, to);
      },
    }),
    substrate: {
      name: "pi" as const,
      displayName: "pi.dev",
      bin: "pi",
      jsonExtractors: TEXT_EXTRACTORS,
      envRequirements: { namespaces: [], keys: [] },
      run: async (o: { systemPrompt?: string; stdin?: string }) => {
        const isOracle = /running the HonestOracle lens/.test(o.systemPrompt ?? "");
        if (isOracle) oracleStdin = o.stdin;
        return {
          stdout: JSON.stringify({ summary: "ok", findings: isOracle ? ORACLE_FINDINGS : [] }),
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
    } as never,
  });
  const oracle = result.verdict.lenses.find((l) => l.lens === "HonestOracle");
  return { result, oracle, oracleStdin, compared };
}

describe("the Oracle on a later round", () => {
  const checkedAtC2 = sageReview("c2", renderCheckedClaimsMarker(checkedClaimsOf(BODY, "c2")));

  test("keeps findings on new claims and drops findings on settled ones", async () => {
    const { oracle } = await reviewRound({ body: BODY, reviews: [checkedAtC2] });

    expect(oracle?.findings.map((f) => f.title)).toEqual(["Cap unproven", "Desc"]);
  });

  test("is told what is unchecked: the changes since its run and the edited description claims", async () => {
    const edited = BODY.replace("empty batches", "empty and oversized batches");
    const { oracleStdin } = await reviewRound({ body: edited, reviews: [checkedAtC2] });

    expect(oracleStdin).toContain("every claim in this PR was checked at commit c2");
    expect(oracleStdin).toContain("+- Batches are capped at 100.");
    expect(oracleStdin).toContain("  - - Adds a guard for empty and oversized batches.");
    expect(oracleStdin).not.toContain("  - This change makes every write atomic.");
  });

  test("compares from its own last run when a later round skipped it", async () => {
    // c2: the Oracle ran. c2b: a code-only round, no Oracle, no marker.
    const skipped = sageReview("c2b", "");
    const { compared, oracleStdin } = await reviewRound({ body: BODY, reviews: [checkedAtC2, skipped] });

    expect(compared).toContain("c2..c3");
    expect(oracleStdin).toContain("+- Batches are capped at 100.");
  });

  test("does not run when nothing since its last run carries a claim", async () => {
    const { oracle } = await reviewRound({
      body: BODY,
      reviews: [checkedAtC2],
      diffBetween: async () =>
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2,1 @@\n+export const read = () => {};\n",
    });

    expect(oracle).toBeUndefined();
  });

  test("records the commit and claims it checked for the next round", async () => {
    const { result } = await reviewRound({ body: BODY, reviews: [checkedAtC2] });

    expect(result.verdict.checkedClaims).toEqual(checkedClaimsOf(BODY, "c3"));
  });

  test("a marker written before sage#139 gets one full check", async () => {
    const legacy = sageReview("c2", `<!-- sage:checked-claims:${digestClaims(BODY)} -->`);
    const { oracle, oracleStdin } = await reviewRound({ body: BODY, reviews: [legacy] });

    expect(oracleStdin).not.toContain("Claims since the last check");
    expect(oracle?.findings).toHaveLength(3);
  });
});
