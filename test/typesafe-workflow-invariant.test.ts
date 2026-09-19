import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";
import { createTypeSafeShadowObserver } from "../src/typesafe/shadow.ts";
import type { ShadowComparisonRecord } from "../src/typesafe/types.ts";
import { renderVerdictBlock } from "../src/verdict/index.ts";
import type { Verdict } from "../src/verdict/types.ts";
import { makeStubForge } from "./forge-stub.ts";

const pr = {
  number: 125,
  title: "shadow invariant",
  body: "",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat/shadow",
  headRefOid: "a".repeat(40),
  author: { login: "alice" },
  changedFiles: 1,
  additions: 1,
  deletions: 0,
  files: [{ path: "src/x.ts", additions: 1, deletions: 0 }],
  url: "https://github.com/x/y/pull/125",
};
const diff = "diff --git a/src/x.ts b/src/x.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n";

let postCalls = 0;
const forge = makeStubForge({
  pr,
  diff,
  postReview: async () => {
    postCalls++;
    return { posted: "approve", downgraded: false };
  },
});
const substrate = {
  name: "pi" as const,
  displayName: "pi.dev",
  bin: "pi",
  jsonExtractors: TEXT_EXTRACTORS,
  envRequirements: { namespaces: [], keys: [] },
  run: async () => ({
    stdout: JSON.stringify({ summary: "ok", findings: [] }),
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  }),
};

function withoutRuntimeDurations(verdict: Verdict): Verdict {
  return {
    ...verdict,
    lenses: verdict.lenses.map((lens) => ({ ...lens, durationMs: 0 })),
  };
}

beforeEach(() => {
  postCalls = 0;
  mock.module("../src/verdict/persist.ts", () => ({
    persistVerdict: () => true,
    verdictFilePath: () => "/tmp/sage-test/typesafe.md",
  }));
});

afterEach(() => mock.restore());

describe("review workflow TypeSafe authority boundary", () => {
  test("observer runs after posting and cannot mutate or change the ordinary result", async () => {
    const events: string[] = [];
    const observingForge = makeStubForge({
      pr,
      diff,
      postReview: async () => {
        events.push("post");
        postCalls++;
        return { posted: "approve", downgraded: false };
      },
    });
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const baseline = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge,
      substrate,
      post: true,
    });
    postCalls = 0;
    const observed = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge: observingForge,
      substrate,
      post: true,
      completedReviewObserver: {
        observe: async (copy) => {
          events.push("shadow");
          expect(Object.isFrozen(copy)).toBe(true);
          expect(Object.isFrozen(copy.pr)).toBe(true);
          expect(() => ((copy.pr as { title: string }).title = "mutated")).toThrow();
        },
      },
    });
    await observed.observerCompletion;
    expect(events).toEqual(["post", "shadow"]);
    expect(postCalls).toBe(1);
    expect(withoutRuntimeDurations(observed.verdict)).toEqual(withoutRuntimeDurations(baseline.verdict));
    expect(observed.posted).toBe(baseline.posted);
    expect(observed.postedEvent).toBe(baseline.postedEvent);
    expect(observed.blockMeta.commit_id).toBe(baseline.blockMeta.commit_id);
    expect(renderVerdictBlock(observed.verdict, observed.blockMeta)).toBe(
      renderVerdictBlock(baseline.verdict, {
        ...baseline.blockMeta,
        submitted_at: observed.blockMeta.submitted_at,
      }),
    );
  });

  test("strong TypeSafe recommendations remain advisory and add no Forge side effects", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const baseline = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge,
      substrate,
      post: false,
    });
    const records: ShadowComparisonRecord[] = [];
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: {
        schemaVersion: 1,
        frozenAt: "2026-09-18T20:00:00.000Z",
        dataProcessingApproval: {
          status: "approved",
          approvedBy: "fixture",
          approvedAt: "2026-09-18T20:00:00.000Z",
          scope: "fixture",
          termsReviewedAt: "2026-09-18T20:00:00.000Z",
        },
        entries: [{
          url: pr.url,
          owner: "x",
          repo: "y",
          number: 125,
          headSha: pr.headRefOid,
          classification: "non-critical-game",
          approvedBy: "fixture",
          approvedAt: "2026-09-18T20:00:00.000Z",
        }],
      },
      transport: {
        execute: async (request) => ({
          model: request.model,
          answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
            const options = Object.keys(question.criteria);
            const choice = id.endsWith(".candidate")
              ? options.find((option) => option.startsWith("candidate_")) ?? "no_signal"
              : id.startsWith("finding.evidence") ? "supported" : "recommend";
            const remainder = (1 - 0.99) / Math.max(1, options.length - 1);
            return [id, {
              type: "choice",
              choice,
              probabilities: Object.fromEntries(
                options.map((option) => [option, option === choice ? 0.99 : remainder]),
              ),
              confidence: 0.99,
            }];
          })),
          usage: { input_tokens: 50, output_tokens: 5 },
        }),
      },
      sink: { write: (record) => records.push(record) },
    });

    postCalls = 0;
    const observed = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge,
      substrate,
      post: false,
      completedReviewObserver: observer,
    });
    await observed.observerCompletion;
    expect(records).toHaveLength(1);
    expect(records[0]?.routing.signals.filter((signal) => signal.family === "routing").every(
      (signal) => signal.answer.choice === "recommend" && signal.disposition === "accepted",
    )).toBe(true);
    expect(withoutRuntimeDurations(observed.verdict)).toEqual(withoutRuntimeDurations(baseline.verdict));
    expect(observed.posted).toBe(false);
    expect(postCalls).toBe(0);
  });

  test("observer failure is caught and preserves ordinary Sage behavior", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const baseline = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge,
      substrate,
      post: false,
    });
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge,
      substrate,
      post: true,
      completedReviewObserver: { observe: async () => { throw new Error("service unavailable"); } },
    });
    await result.observerCompletion;
    expect(result.posted).toBe(true);
    expect(withoutRuntimeDurations(result.verdict)).toEqual(withoutRuntimeDurations(baseline.verdict));
    expect(postCalls).toBe(1);
  });

  test("returns the completed Review before advisory observation finishes", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observerFinished = false;

    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge,
      substrate,
      post: false,
      completedReviewObserver: {
        observe: async () => {
          await blocked;
          observerFinished = true;
        },
      },
    });

    expect(result.verdict).toBeDefined();
    expect(observerFinished).toBe(false);
    release();
    await result.observerCompletion;
    expect(observerFinished).toBe(true);
  });

  test("does not add Forge reads for advisory observation", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    let prViewCalls = 0;
    let observed = false;
    const checkingForge = {
      ...forge,
      prView: async () => {
        prViewCalls++;
        return pr;
      },
    };

    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge: checkingForge,
      substrate,
      post: false,
      completedReviewObserver: {
        observe: async () => { observed = true; },
      },
    });

    expect(prViewCalls).toBe(1);
    expect(observed).toBe(false);
    await result.observerCompletion;
    expect(prViewCalls).toBe(1);
    expect(observed).toBe(true);
  });

  test("checks observer authorization before creating the completed Review snapshot", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    let observed = false;
    const review = await reviewPr({
      ref: { owner: "x", repo: "y", number: 125 },
      forge,
      substrate,
      post: false,
      completedReviewObserver: {
        accepts: (anchor) => {
          expect(anchor).toEqual({
            ref: { owner: "x", repo: "y", number: 125 },
            headSha: pr.headRefOid,
          });
          return false;
        },
        observe: async () => { observed = true; },
      },
    });

    await review.observerCompletion;
    expect(observed).toBe(false);
  });
});
