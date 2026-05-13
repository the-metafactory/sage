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
let postReviewCalls = 0;

beforeEach(() => {
  persistedCount = 0;
  postReviewCalls = 0;
  postReviewBehavior = "success";

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
        throw new Error("gh pr review failed (exit 1): network unreachable");
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
    expect(result.postError).toBeInstanceOf(Error);
    expect(result.postError?.message).toMatch(/network unreachable/);
    // Verdict was still persisted — recovery path remains.
    expect(persistedCount).toBe(1);
    expect(postReviewCalls).toBe(1);
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
