import { describe, expect, test } from "bun:test";

import { buildBoundedCommentState } from "../src/typesafe/comment-hygiene.ts";
import { createTypeSafeShadowObserver } from "../src/typesafe/shadow.ts";
import { TYPESAFE_POLICY } from "../src/typesafe/policy.ts";
import type {
  ShadowComparisonRecord,
  ShadowReviewInput,
  SystemOneRequest,
  TypeSafeTransport,
} from "../src/typesafe/types.ts";

const HEAD = "c".repeat(40);
const input: ShadowReviewInput = {
  ref: { owner: "the-metafactory", repo: "seelite", number: 42 },
  pr: {
    number: 42,
    title: "Tidy commentary",
    body: "",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/comments",
    headRefOid: HEAD,
    author: { login: "pilot" },
    changedFiles: 2,
    additions: 5,
    deletions: 0,
    files: [
      { path: "src/engine.ts", additions: 3, deletions: 0 },
      { path: "src/notes.py", additions: 2, deletions: 0 },
    ],
    url: "https://github.com/the-metafactory/seelite/pull/42",
  },
  diff: `diff --git a/src/engine.ts b/src/engine.ts
@@ -1 +1,3 @@
+const executable = run(); // Phase 2: remove after #1234
+// API_KEY=comment-secret
+/* This is load-bearing plumbing. */
diff --git a/src/notes.py b/src/notes.py
@@ -1 +1,2 @@
+def ship():
+    \"\"\"Explains how the old implementation behaved.\"\"\"`,
  selectedLensNames: ["CodeQuality"],
  lensReports: [],
  verdict: { decision: "approved", summary: "clean", lenses: [] },
  posted: false,
};

const corpus = {
  schemaVersion: 1 as const,
  frozenAt: "2026-09-20T00:00:00.000Z",
  dataProcessingApproval: {
    status: "approved" as const,
    approvedBy: "fixture",
    approvedAt: "2026-09-20T00:00:00.000Z",
    scope: "fixture",
    termsReviewedAt: "2026-09-20T00:00:00.000Z",
  },
  entries: [{
    url: input.pr.url,
    owner: input.ref.owner,
    repo: input.ref.repo,
    number: input.ref.number,
    headSha: HEAD,
    classification: "non-critical-game" as const,
    approvedBy: "fixture",
    approvedAt: "2026-09-20T00:00:00.000Z",
  }],
};

function responseFor(request: SystemOneRequest, badCommentAnswer = false, commentChoice = "planning_context") {
  return {
    model: request.model,
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      const choice = id.startsWith("code_smell.v1.")
        ? (badCommentAnswer ? "not_a_smell" : commentChoice)
        : id.endsWith(".candidate")
          ? "no_signal"
          : id.startsWith("finding.evidence") ? "supported" : "do_not_recommend";
      const remainder = (1 - 0.99) / Math.max(1, options.length - 1);
      return [id, {
        type: "choice",
        choice,
        probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 0.99 : remainder])),
        confidence: 0.99,
      }];
    })),
    usage: { input_tokens: 10, output_tokens: 1 },
  };
}

describe("TypeSafe CommentHygiene", () => {
  test("groups TypeScript JSDoc and retains only its following declaration signature", () => {
    const state = buildBoundedCommentState(`diff --git a/src/ship.ts b/src/ship.ts
@@ -0,0 +1,4 @@
+/**
+ * Returns the current ship state.
+ */
+export function ship() { return secret(); }`, TYPESAFE_POLICY);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]).toMatchObject({
      syntax: "docstring",
      text: "/**\n* Returns the current ship state.\n*/",
      declarationContext: "export function ship()",
    });
    expect(JSON.stringify(state)).not.toContain("return secret");
  });

  test("does not export a const initializer or a bare multiplication line as documentation context", () => {
    const state = buildBoundedCommentState(`diff --git a/src/ship.ts b/src/ship.ts
@@ -0,0 +1,5 @@
+/** configured ship */
+export const ship = secret();
+const product = left
+  * right;
+// ordinary note`, TYPESAFE_POLICY);
    expect(state.comments).toMatchObject([{
      syntax: "docstring",
      declarationContext: "export const ship",
    }, {
      syntax: "line_comment",
      text: "// ordinary note",
    }]);
    expect(JSON.stringify(state)).not.toContain("secret()");
  });

  test("extracts only added comment/docstring spans and redacts them before transport", () => {
    const state = buildBoundedCommentState(input.diff, TYPESAFE_POLICY);
    const serialized = JSON.stringify(state);
    expect(state.comments.map((span) => span.syntax)).toEqual([
      "line_comment", "line_comment", "block_comment", "docstring",
    ]);
    expect(state.comments.map((span) => span.id)).toEqual([
      "comment_1", "comment_2", "comment_3", "comment_4",
    ]);
    expect(state.comments[3]?.declarationContext).toBe("def ship():");
    expect(serialized).not.toContain("const executable = run");
    expect(serialized).not.toContain("comment-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(TYPESAFE_POLICY.commentHygiene.maxStateChars);
  });

  test("sends the exact closed Choice and records an accepted non-authoritative signal", async () => {
    const requests: SystemOneRequest[] = [];
    const records: ShadowComparisonRecord[] = [];
    const transport: TypeSafeTransport = {
      execute: async (request) => {
        requests.push(request);
        return responseFor(request);
      },
    };
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus,
      transport,
      sink: { write: (record) => records.push(record) },
    });

    await observer.observe(input);

    const request = requests.find((candidate) => Object.hasOwn(candidate.questions, "code_smell.v1.comment_1"));
    expect(request).toBeDefined();
    expect(Object.keys(request!.questions).filter((id) => id.startsWith("code_smell.v1."))).toEqual([
      "code_smell.v1.comment_1",
      "code_smell.v1.comment_2",
      "code_smell.v1.comment_3",
      "code_smell.v1.comment_4",
    ]);
    expect(Object.keys(request!.questions["code_smell.v1.comment_4"]!.criteria)).toEqual([
      "change_history",
      "planning_context",
      "code_restatement",
      "mechanism_over_rationale",
      "ephemeral_context",
      "filler_jargon",
      "none",
    ]);
    expect(JSON.stringify(request!.questions["code_smell.v1.comment_4"]!.instructions)).toContain("declarationContext");
    expect(JSON.stringify(request!.state)).not.toContain("const executable = run");
    expect(records[0]?.commentHygiene?.stage.signals[0]).toMatchObject({
      family: "comment_hygiene",
      questionId: "code_smell.v1.comment_1",
      answer: { choice: "planning_context", confidence: 0.99 },
      disposition: "accepted",
    });
    expect(records[0]?.commentHygiene?.stage.signals[3]).toMatchObject({
      questionId: "code_smell.v1.comment_4",
      floor: TYPESAFE_POLICY.commentHygiene.docstringCandidateFloor,
      selectedCandidateId: "comment_4",
    });
  });

  test("fails only the comment-hygiene stage when its typed answer is invalid", async () => {
    const records: ShadowComparisonRecord[] = [];
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus,
      transport: { execute: async (request) => responseFor(request, true) },
      sink: { write: (record) => records.push(record) },
    });

    await observer.observe(input);

    expect(records[0]?.routing.status).toBe("ok");
    expect(records[0]?.commentHygiene?.stage.status).toBe("failed");
    expect(records[0]?.commentHygiene?.stage.failureReason).toContain("invalid choice");
  });

  test("keeps the none criterion out of the candidate gate", async () => {
    const records: ShadowComparisonRecord[] = [];
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus,
      transport: { execute: async (request) => responseFor(request, false, "none") },
      sink: { write: (record) => records.push(record) },
    });

    await observer.observe(input);

    expect(records[0]?.commentHygiene?.stage.signals.every((signal) => signal.disposition === "no_signal")).toBe(true);
  });
});
