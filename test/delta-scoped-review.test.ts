import { describe, expect, mock, test } from "bun:test";
import { makeStubForge } from "./forge-stub.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";
import { runLenses } from "../src/lenses/scheduler.ts";
import type { LensModule } from "../src/lenses/registry.ts";
import type { LensRunInput } from "../src/lenses/base.ts";
import type { LensReport } from "../src/lenses/types.ts";

/**
 * sage#107 — delta-scoped review.
 *
 * Every round used to send the CUMULATIVE PR diff to every applicable lens, so
 * round 12 re-read the code that settled at round 5 and paid for it twice over:
 * once in tokens, once in the nits that re-reading settled code produces. A
 * lens now declares how much of the change it needs, and the workflow feeds it
 * exactly that.
 */

const CUMULATIVE = `diff --git a/src/a.ts b/src/a.ts
+everything the PR has ever changed
`;
const DELTA = `diff --git a/src/a.ts b/src/a.ts
+only what changed since Sage last looked
`;

function capturingLens(name: string, scope?: "delta" | "cumulative"): {
  lens: LensModule;
  seen: () => string | undefined;
} {
  let seen: string | undefined;
  const lens: LensModule = {
    name,
    review: async (input: LensRunInput): Promise<LensReport> => {
      seen = input.diff;
      return { lens: name, summary: "", findings: [], durationMs: 0 };
    },
    ...(scope ? { reviewScope: scope } : {}),
  };
  return { lens, seen: () => seen };
}

const stubSubstrate = {
  name: "pi" as const,
  displayName: "pi.dev",
  bin: "pi",
  jsonExtractors: TEXT_EXTRACTORS,
  envRequirements: { namespaces: [], keys: [] },
  run: async () => ({ stdout: "{}", stderr: "", exitCode: 0, durationMs: 1 }),
};

const scheduleBase = {
  substrate: stubSubstrate as never,
  priorFindings: [],
  lensesAreApplicable: true,
};

describe("sage#107 delta-scoped review — scheduler", () => {
  test("a delta-scoped lens reads the delta; a cumulative-scoped lens reads the whole change", async () => {
    const local = capturingLens("CodeQuality", "delta");
    const global = capturingLens("Maintainability", "cumulative");

    await runLenses({
      ...scheduleBase,
      lenses: [local.lens, global.lens],
      ctx: { pr: { number: 1 } as never, diff: CUMULATIVE },
      deltaDiff: DELTA,
    });

    expect(local.seen()).toBe(DELTA);
    expect(global.seen()).toBe(CUMULATIVE);
  });

  test("a lens with no declared scope defaults to the whole change", async () => {
    const undeclared = capturingLens("Architecture");

    await runLenses({
      ...scheduleBase,
      lenses: [undeclared.lens],
      ctx: { pr: { number: 1 } as never, diff: CUMULATIVE },
      deltaDiff: DELTA,
    });

    expect(undeclared.seen()).toBe(CUMULATIVE);
  });

  test("without a delta every lens falls back to the whole change", async () => {
    const local = capturingLens("CodeQuality", "delta");
    const global = capturingLens("Maintainability", "cumulative");

    await runLenses({
      ...scheduleBase,
      lenses: [local.lens, global.lens],
      ctx: { pr: { number: 1 } as never, diff: CUMULATIVE },
    });

    expect(local.seen()).toBe(CUMULATIVE);
    expect(global.seen()).toBe(CUMULATIVE);
  });
});

// ── workflow level ───────────────────────────────────────────────────────────

const PRIOR_REVIEW_BODY = `## Sage code review — changes-requested

1 finding(s).

### CodeQuality

- **[nit]** \`src/a.ts:1\` — **Something**
  Rationale.
`;

function stubPr(files: { path: string; additions: number; deletions: number }[]) {
  return {
    number: 7,
    title: "test",
    baseRefName: "main",
    headRefName: "feat/y",
    headRefOid: "head-sha",
    author: { login: "alice" },
    body: "",
    changedFiles: files.length,
    files,
  };
}

function reviewSourceWithPriorSageReview() {
  return {
    fetchReviewBodies: async () => ({
      sageLogin: "sage",
      bodies: [
        {
          authorLogin: "sage",
          body: PRIOR_REVIEW_BODY,
          postedAt: "2026-08-01T00:00:00Z",
          commitId: "prior-sha",
        },
      ],
    }),
  };
}

async function reviewWith(opts: {
  files: { path: string; additions: number; deletions: number }[];
  cumulative: string;
  diffBetween?: (from: string, to: string) => Promise<string>;
}) {
  mock.module("../src/util/persistence.ts", () => ({
    persistVerdict: () => true,
    verdictFilePath: () => "/tmp/sage-test/x.md",
    safeRefSegment: (v: string) => v.replace(/[^a-zA-Z0-9._-]/g, "_"),
  }));
  const { reviewPr } = await import("../src/lenses/workflow.ts");
  const lensesRun: string[] = [];
  const substrate = {
    ...stubSubstrate,
    run: async (o: { systemPrompt?: string }) => {
      const named = /running the (\w+) lens/.exec(o.systemPrompt ?? "");
      if (named?.[1]) lensesRun.push(named[1]);
      return {
        stdout: JSON.stringify({ summary: "ok", findings: [] }),
        stderr: "",
        exitCode: 0,
        durationMs: 1,
      };
    },
  };
  const result = await reviewPr({
    ref: { owner: "x", repo: "y", number: 7 },
    forge: makeStubForge({
      pr: stubPr(opts.files),
      diff: opts.cumulative,
      reviewSource: reviewSourceWithPriorSageReview() as never,
      ...(opts.diffBetween ? { diffBetween: opts.diffBetween } : {}),
    }),
    substrate: substrate as never,
  });
  return { result, lensesRun };
}

describe("sage#107 delta-scoped review — workflow", () => {
  // Round 1 touched src/auth.ts, which trips Security (path) and Performance
  // (`setInterval` in the body). Round 12 touched only a markdown file. The
  // security and performance questions settled rounds ago; re-asking them every
  // round is the waste this change removes.
  const CUMULATIVE_WITH_TRIGGERS = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,0 +1,2 @@
+const token = 'xyz';
+setInterval(() => tick(), 1000);
`;
  const DOCS_ONLY_DELTA = `diff --git a/docs/notes.md b/docs/notes.md
--- a/docs/notes.md
+++ b/docs/notes.md
@@ -1,0 +1,1 @@
+A clarifying paragraph added this round.
`;

  const FILES = [
    { path: "src/auth.ts", additions: 25, deletions: 0 },
    { path: "docs/notes.md", additions: 1, deletions: 0 },
  ];

  test("applicability reads the delta, so a lens whose trigger has settled stops firing", async () => {
    const { lensesRun } = await reviewWith({
      files: FILES,
      cumulative: CUMULATIVE_WITH_TRIGGERS,
      diffBetween: async () => DOCS_ONLY_DELTA,
    });

    // CodeQuality is unconditional and always has something to say.
    expect(lensesRun).toContain("CodeQuality");
    // Path- and body-triggered lenses whose subject this round did not touch.
    expect(lensesRun).not.toContain("Security");
    expect(lensesRun).not.toContain("Performance");
  });

  test("a lens still fires when the delta DOES touch its subject", async () => {
    const authDelta = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -5,0 +5,1 @@
+const apiKey = process.env.API_KEY;
`;
    const { lensesRun } = await reviewWith({
      files: FILES,
      cumulative: CUMULATIVE_WITH_TRIGGERS,
      diffBetween: async () => authDelta,
    });

    expect(lensesRun).toContain("Security");
  });

  test("a forge that cannot compare commits keeps every applicable lens firing", async () => {
    const { lensesRun } = await reviewWith({
      files: FILES,
      cumulative: CUMULATIVE_WITH_TRIGGERS,
    });

    expect(lensesRun).toContain("CodeQuality");
    expect(lensesRun).toContain("Security");
    expect(lensesRun).toContain("Performance");
  });

  test("a failed comparison discloses the coverage gap and reviews everything", async () => {
    const { result, lensesRun } = await reviewWith({
      files: FILES,
      cumulative: CUMULATIVE_WITH_TRIGGERS,
      diffBetween: async () => {
        throw new Error("compare endpoint unreachable");
      },
    });

    expect(lensesRun).toContain("Security");
    expect(result.verdict.lenses.every((l) => l.previousRoundSurfaceUnavailable)).toBe(true);
    expect(result.verdict.convergence?.previousRoundSurfaceUnavailable).toBe(true);
  });
});
