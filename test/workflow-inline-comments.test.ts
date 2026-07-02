import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeStubForge } from "./forge-stub.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";
import type { PostReviewInput } from "../src/forge/types.ts";

/**
 * compass#99 F15 — line-anchored findings become inline PR comments, and
 * `VerdictBlockMeta.inline_comments` reports the REAL count posted (not
 * the pre-F15 hardcoded `0`).
 *
 * Fixture is shaped to fire ONLY the always-on CodeQuality lens (per
 * `src/lenses/applicability.ts`: no `src/**` .ts path → Architecture
 * skips; no auth/token/etc keyword → Security skips; no arc-manifest.yaml
 * → EcosystemCompliance skips; no `setInterval(` in diff → Performance
 * skips; `.bin` extension → Maintainability + HonestOracle skip; short
 * body → HonestOracle stays off too) so the lens count — and therefore
 * the finding/comment count — is deterministic.
 */

const stubPr = {
  number: 99,
  title: "test",
  baseRefName: "main",
  headRefName: "feat/f15",
  author: { login: "alice" },
  body: "",
  changedFiles: 1,
  files: [{ path: "assets/logo.bin", additions: 2, deletions: 0 }],
  headRefOid: "deadbeef",
};

const stubDiff = "diff --git a/assets/logo.bin b/assets/logo.bin\nBinary files differ\n";

let postReviewCalls: PostReviewInput[] = [];
let postReviewBehavior: "success" | "throw" = "success";

const stubForge = makeStubForge({
  pr: stubPr,
  diff: stubDiff,
  postReview: async (input) => {
    postReviewCalls.push(input);
    if (postReviewBehavior === "throw") {
      throw new Error("gh api failed (exit 1): network unreachable");
    }
    return { posted: "comment" as const, downgraded: false };
  },
});

let runJsonResult: { summary: string; findings: unknown[] };

const stubSubstrate = {
  name: "pi" as const,
  displayName: "pi.dev",
  bin: "pi",
  jsonExtractors: TEXT_EXTRACTORS,
  envRequirements: { namespaces: [], keys: [] },
  run: async () => ({
    stdout: JSON.stringify(runJsonResult),
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  }),
};

beforeEach(() => {
  postReviewCalls = [];
  postReviewBehavior = "success";
  runJsonResult = {
    summary: "two real findings, one file-level",
    findings: [
      {
        path: "assets/logo.bin",
        line: 3,
        severity: "important",
        title: "binary asset checked in without LFS",
        rationale: "quoted diff text here",
      },
      {
        path: "assets/logo.bin",
        line: 7,
        severity: "nit",
        title: "trailing whitespace",
        rationale: "quoted diff text here too",
        suggestion: "trim the line",
      },
      // File-level finding (line: 0, per Finding's contract) — must NOT
      // become an inline comment; GitHub's API rejects comments with no
      // diff-anchored line.
      {
        path: "assets/logo.bin",
        line: 0,
        severity: "suggestion",
        title: "consider a README note for this asset",
        rationale: "file-level observation",
      },
    ],
  };

  mock.module("../src/verdict/persist.ts", () => ({
    persistVerdict: () => true,
    verdictFilePath: (ref: { owner: string; repo: string; number: number }, ext: string) =>
      `/tmp/sage-test/${ref.owner}-${ref.repo}-${ref.number}.${ext}`,
  }));
});

afterEach(() => {
  mock.restore();
});

describe("reviewPr inline comments (compass#99 F15)", () => {
  test("posts N inline comments for N line-anchored findings and reports the real count", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 99 },
      forge: stubForge,
      substrate: stubSubstrate,
      post: true,
    });

    expect(postReviewCalls.length).toBe(1);
    const posted = postReviewCalls[0]!;
    expect(posted.comments).toBeDefined();
    expect(posted.comments!.length).toBe(2);
    expect(posted.comments).toEqual([
      {
        path: "assets/logo.bin",
        line: 3,
        body: expect.stringContaining("binary asset checked in without LFS"),
      },
      {
        path: "assets/logo.bin",
        line: 7,
        body: expect.stringContaining("trim the line"),
      },
    ]);

    // Honest count (drift-5): matches what was actually posted, not a
    // hardcoded 0.
    expect(result.blockMeta.inline_comments).toBe(2);
  });

  test("file-level finding (line: 0) never becomes an inline comment", async () => {
    runJsonResult = {
      summary: "one file-level finding only",
      findings: [
        {
          path: "assets/logo.bin",
          line: 0,
          severity: "suggestion",
          title: "file-level only",
          rationale: "no diff anchor",
        },
      ],
    };

    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 99 },
      forge: stubForge,
      substrate: stubSubstrate,
      post: true,
    });

    const posted = postReviewCalls[0]!;
    expect(posted.comments).toBeUndefined();
    expect(result.blockMeta.inline_comments).toBe(0);
  });

  test("inline_comments is 0 when nothing was posted (opts.post = false)", async () => {
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 99 },
      forge: stubForge,
      substrate: stubSubstrate,
      post: false,
    });

    expect(postReviewCalls.length).toBe(0);
    expect(result.blockMeta.inline_comments).toBe(0);
  });

  test("inline_comments is 0 (honest) when the post attempt fails", async () => {
    postReviewBehavior = "throw";
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 99 },
      forge: stubForge,
      substrate: stubSubstrate,
      post: true,
    });

    expect(result.posted).toBe(false);
    expect(result.blockMeta.inline_comments).toBe(0);
  });
});
