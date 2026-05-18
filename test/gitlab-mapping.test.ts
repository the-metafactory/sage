import { describe, test, expect } from "bun:test";
import {
  mapGlMrToPrMetadata,
  countDiffLines,
  stitchUnifiedDiff,
  postReviewWithFallback,
  SELF_REVIEW_BLOCK_RE_GITLAB,
  type GitLabPostReviewDeps,
  type GlMergeRequest,
  type GlMrChanges,
} from "../src/forge/gitlab/backend.ts";

/**
 * Mapping primitives are exported separately from the GitLabBackend
 * class so they can be exercised without spinning up a `glab`
 * subprocess. Mirrors the testing approach in
 * `the-metafactory/pilot/test/forge/gitlab-backend.test.ts` whose
 * shape these mappings derive from.
 */

describe("countDiffLines", () => {
  test("counts +/- lines, skips +++ / --- file headers", () => {
    const diff = [
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "+added line",
      "+another added",
      "-removed line",
    ].join("\n");
    expect(countDiffLines(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  test("handles empty diff", () => {
    expect(countDiffLines("")).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("stitchUnifiedDiff", () => {
  test("prepends a diff --git header per file", () => {
    const result = stitchUnifiedDiff({
      changes: [
        {
          old_path: "a.ts",
          new_path: "a.ts",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
        {
          old_path: "b.ts",
          new_path: "b.ts",
          diff: "@@ -1 +1 @@\n-x\n+y\n",
        },
      ],
    });
    expect(result).toContain("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@");
    expect(result).toContain("diff --git a/b.ts b/b.ts\n@@ -1 +1 @@");
  });

  test("uses new_path when old_path is empty (added file)", () => {
    const result = stitchUnifiedDiff({
      changes: [{ old_path: "", new_path: "new.ts", diff: "@@ +1 @@\n+x\n" }],
    });
    expect(result.startsWith("diff --git a/new.ts b/new.ts\n")).toBe(true);
  });

  test("adds trailing newline so adjacent file headers start at col 0", () => {
    const result = stitchUnifiedDiff({
      changes: [
        { old_path: "a.ts", new_path: "a.ts", diff: "@@ +1 @@\n+x" }, // no trailing \n
        { old_path: "b.ts", new_path: "b.ts", diff: "@@ +1 @@\n+y\n" },
      ],
    });
    expect(result).toContain("+x\ndiff --git a/b.ts b/b.ts");
  });
});

describe("mapGlMrToPrMetadata", () => {
  const baseMr: GlMergeRequest = {
    iid: 42,
    title: "Add feature",
    description: "Body text",
    state: "opened",
    draft: false,
    merged_at: null,
    sha: "abc123",
    source_branch: "feat/x",
    diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
    target_branch: "main",
    web_url: "https://gitlab.com/group/proj/-/merge_requests/42",
    author: { username: "alice" },
  };

  const baseChanges: GlMrChanges = {
    changes: [
      {
        old_path: "a.ts",
        new_path: "a.ts",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
      },
      {
        old_path: "b.ts",
        new_path: "b.ts",
        diff: "@@ -1,0 +1,2 @@\n+added 1\n+added 2\n",
      },
    ],
  };

  test("maps basic MR fields into PrMetadata shape", () => {
    const meta = mapGlMrToPrMetadata(baseMr, baseChanges);
    expect(meta.number).toBe(42);
    expect(meta.title).toBe("Add feature");
    expect(meta.body).toBe("Body text");
    expect(meta.baseRefName).toBe("main");
    expect(meta.headRefName).toBe("feat/x");
    expect(meta.author.login).toBe("alice");
    expect(meta.url).toBe("https://gitlab.com/group/proj/-/merge_requests/42");
  });

  test("normalizes GitLab 'opened' state to 'open'", () => {
    expect(mapGlMrToPrMetadata(baseMr, baseChanges).state).toBe("open");
  });

  test("preserves 'closed' and 'merged' states", () => {
    expect(
      mapGlMrToPrMetadata({ ...baseMr, state: "closed" }, baseChanges).state,
    ).toBe("closed");
    expect(
      mapGlMrToPrMetadata({ ...baseMr, state: "merged" }, baseChanges).state,
    ).toBe("merged");
  });

  test("derives changedFiles + additions + deletions from per-file diffs", () => {
    const meta = mapGlMrToPrMetadata(baseMr, baseChanges);
    expect(meta.changedFiles).toBe(2);
    expect(meta.additions).toBe(3);
    expect(meta.deletions).toBe(1);
    expect(meta.files).toEqual([
      { path: "a.ts", additions: 1, deletions: 1 },
      { path: "b.ts", additions: 2, deletions: 0 },
    ]);
  });

  test("treats null description as empty body", () => {
    expect(mapGlMrToPrMetadata({ ...baseMr, description: null }, baseChanges).body).toBe("");
  });

  test("derives isDraft from `draft` flag when present", () => {
    expect(mapGlMrToPrMetadata({ ...baseMr, draft: true }, baseChanges).isDraft).toBe(true);
  });

  test("falls back to legacy `work_in_progress` flag", () => {
    expect(
      mapGlMrToPrMetadata(
        { ...baseMr, draft: undefined, work_in_progress: true },
        baseChanges,
      ).isDraft,
    ).toBe(true);
  });
});

describe("postReviewWithFallback (GitLab)", () => {
  function stubDeps(overrides: Partial<GitLabPostReviewDeps> = {}): {
    calls: string[];
    deps: GitLabPostReviewDeps;
  } {
    const calls: string[] = [];
    const deps: GitLabPostReviewDeps = {
      approve: async () => {
        calls.push("approve");
      },
      unapprove: async () => {
        calls.push("unapprove");
      },
      postNote: async () => {
        calls.push("postNote");
      },
      log: () => {},
      ...overrides,
    };
    return { calls, deps };
  }

  test("comment posts only the note", async () => {
    const { calls, deps } = stubDeps();
    const result = await postReviewWithFallback("comment", deps);
    expect(calls).toEqual(["postNote"]);
    expect(result).toEqual({ posted: "comment", downgraded: false });
  });

  test("approve calls approve then postNote", async () => {
    const { calls, deps } = stubDeps();
    const result = await postReviewWithFallback("approve", deps);
    expect(calls).toEqual(["approve", "postNote"]);
    expect(result).toEqual({ posted: "approve", downgraded: false });
  });

  test("request-changes calls unapprove then postNote", async () => {
    const { calls, deps } = stubDeps();
    const result = await postReviewWithFallback("request-changes", deps);
    expect(calls).toEqual(["unapprove", "postNote"]);
    expect(result).toEqual({ posted: "request-changes", downgraded: false });
  });

  test("approve falls back to comment when GitLab blocks self-approval", async () => {
    const { calls, deps } = stubDeps({
      approve: async () => {
        calls.push("approve(blocked)");
        throw new Error("403: user cannot approve own MR");
      },
    });
    const result = await postReviewWithFallback("approve", deps);
    expect(calls).toEqual(["approve(blocked)", "postNote"]);
    expect(result).toEqual({ posted: "comment", downgraded: true });
  });

  test("non-self-review errors propagate without fallback", async () => {
    const { deps } = stubDeps({
      approve: async () => {
        throw new Error("500 internal error");
      },
    });
    await expect(postReviewWithFallback("approve", deps)).rejects.toThrow(/500/);
  });

  test("self-review regex matches expected GitLab error wording", () => {
    expect(SELF_REVIEW_BLOCK_RE_GITLAB.test("user cannot approve own merge request")).toBe(true);
    expect(SELF_REVIEW_BLOCK_RE_GITLAB.test("Access denied: self-approval disabled")).toBe(true);
    expect(SELF_REVIEW_BLOCK_RE_GITLAB.test("404 Not Found")).toBe(false);
  });
});
