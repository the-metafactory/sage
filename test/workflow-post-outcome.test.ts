import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * sage#16: `ReviewResult.posted` reflects ACTUAL post outcome (whether
 * `postReview` returned without throwing), not just the caller's intent.
 * On post failure the verdict is preserved on disk via `persistVerdict`
 * and the error is surfaced on `ReviewResult.postError`.
 *
 * Pre-#16 a post-side throw escaped out of `reviewPr` and conflated a
 * post failure with a lens failure (the bridge's outer catch published
 * `dispatch.task.failed`, discarding the otherwise-valid verdict). The
 * tests below pin both halves of the new behavior: success path returns
 * `posted: true`, failure path returns `posted: false` + `postError`
 * WITHOUT throwing.
 */

const stubPr = {
  number: 42,
  title: "test",
  baseRefName: "main",
  headRefName: "feat/x",
  author: { login: "alice" },
  body: "",
  changedFiles: 1,
  files: [{ path: "src/x.ts", additions: 1, deletions: 0 }],
};

const stubDiff = "diff --git a/src/x.ts b/src/x.ts\n+console.log('x');\n";

const stubSubstrate = {
  name: "pi" as const,
  displayName: "pi.dev",
  bin: "pi",
  run: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 }),
  runJson: async <T>() => ({
    result: { summary: "ok", findings: [] } as unknown as T,
    raw: { stdout: "", stderr: "", exitCode: 0, durationMs: 1 },
  }),
};

let persistedCount = 0;
let postReviewBehavior: "success" | "throw" = "success";
let postReviewErrorMessage = "gh pr review failed (exit 1): network unreachable";
let postReviewCalls = 0;

beforeEach(() => {
  persistedCount = 0;
  postReviewCalls = 0;
  postReviewBehavior = "success";
  postReviewErrorMessage = "gh pr review failed (exit 1): network unreachable";

  mock.module("../src/github/gh.ts", () => ({
    parsePrRef: (ref: string) => {
      const m = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
      if (!m) throw new Error(`bad ref ${ref}`);
      return { owner: m[1], repo: m[2], number: Number(m[3]) };
    },
    prView: async () => stubPr,
    prDiff: async () => stubDiff,
    postReview: async () => {
      postReviewCalls++;
      if (postReviewBehavior === "throw") {
        throw new Error(postReviewErrorMessage);
      }
      return { posted: "comment" as const, downgraded: false };
    },
  }));

  mock.module("../src/util/persistence.ts", () => ({
    persistVerdict: () => {
      persistedCount++;
    },
  }));
});

afterEach(() => {
  mock.restore();
});

describe("reviewPr post-outcome contract (sage#16)", () => {
  test("posted=true when postReview succeeds", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 42 },
      substrate: stubSubstrate,
      post: true,
    });
    expect(result.posted).toBe(true);
    expect(result.postError).toBeUndefined();
    expect(persistedCount).toBe(1);
    expect(postReviewCalls).toBe(1);
  });

  test("posted=false + postError set when postReview throws (does NOT re-throw)", async () => {
    postReviewBehavior = "throw";
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 42 },
      substrate: stubSubstrate,
      post: true,
    });
    expect(result.posted).toBe(false);
    // postError is a structured shape (sage#16 round 2 review) so it can
    // cross the bus without serialization gymnastics — `Error` instances
    // don't JSON-serialize cleanly.
    expect(result.postError).toBeDefined();
    expect(typeof result.postError?.message).toBe("string");
    expect(result.postError?.message).toMatch(/network unreachable/);
    // Verdict was still persisted — recovery path remains.
    expect(persistedCount).toBe(1);
    expect(postReviewCalls).toBe(1);
  });

  test("postError.message is truncated when gh stderr is large", async () => {
    // The previous postReview rejection message embeds gh's stderr
    // verbatim (see runGh in src/github/gh.ts). Truncation caps the
    // blast radius if gh ever echoes unexpected content during a crash.
    // Reuses the beforeEach mock by toggling behavior + injecting the
    // large message; no need to re-define the full mock module.
    postReviewBehavior = "throw";
    postReviewErrorMessage = `gh pr review failed (exit 1): ${"X".repeat(5000)}`;
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 42 },
      substrate: stubSubstrate,
      post: true,
    });
    expect(result.posted).toBe(false);
    const msg = result.postError?.message ?? "";
    // Tighter behavioral bound: original message was 5000+ chars; the
    // truncated form must be under 700 (cap + worst-case suffix).
    expect(msg.length).toBeLessThanOrEqual(700);
    expect(msg).toMatch(/truncated \d+ chars/);
  });

  test("posted=false + postReview NOT called when opts.post is false", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 42 },
      substrate: stubSubstrate,
      post: false,
    });
    expect(result.posted).toBe(false);
    expect(result.postError).toBeUndefined();
    expect(postReviewCalls).toBe(0);
    // Persisted regardless of post intent — that's the whole point of
    // persisting BEFORE the post step.
    expect(persistedCount).toBe(1);
  });
});
