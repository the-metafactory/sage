import { afterEach, describe, expect, test } from "bun:test";
import {
  createGitHubReviewSource,
  createGitLabReviewSource,
  createInMemoryReviewSource,
  createPriorFindings,
} from "../src/prior-findings/index.ts";
import { parseSageReviewFindings } from "../src/forge/prior-findings.ts";

const ref = { owner: "x", repo: "y", number: 1 };

const sageBody = `## Sage code review — changes-requested

2 finding(s): 1 important, 1 suggestion.

### Architecture
one issue

- **[important]** \`src/a.ts:42\` — **Duplicate trigger pattern**
  The diff repeats \`trigger()\`.

### Maintainability
one issue

- **[suggestion]** \`src/b.ts:7\` — **Extract common helper**
  The diff repeats \`helper()\`.
`;

describe("parseSageReviewFindings (sage#32, forge-agnostic parser)", () => {
  test("extracts Sage-rendered findings from prior review bodies", () => {
    const findings = parseSageReviewFindings(sageBody);
    expect(findings).toEqual([
      {
        path: "src/a.ts",
        line: 42,
        severity: "important",
        title: "Duplicate trigger pattern",
      },
      {
        path: "src/b.ts",
        line: 7,
        severity: "suggestion",
        title: "Extract common helper",
      },
    ]);
  });

  test("ignores non-Sage review bodies", () => {
    expect(parseSageReviewFindings("- **[important]** `x.ts:1` — **Looks similar**")).toEqual([]);
  });
});

describe("PriorFindings Module (sage#56)", () => {
  test("status=ok: gates by trusted author, parses, enriches with postedAt", async () => {
    const source = createInMemoryReviewSource({
      behavior: {
        kind: "ok",
        result: {
          sageLogin: "jcfischer",
          bodies: [
            { authorLogin: "attacker", body: sageBody, postedAt: "2026-05-01T00:00:00Z" },
            {
              authorLogin: "jcfischer",
              body: sageBody,
              postedAt: "2026-05-10T12:00:00Z",
              commitId: "prior-head",
            },
          ],
        },
      },
    });

    const result = await createPriorFindings(source).collect(ref);

    expect(result.status).toBe("ok");
    expect(result.identity).toEqual({ login: "jcfischer" });
    expect(result.latestReviewCommitId).toBe("prior-head");
    expect(result.reviewCount).toBe(1);
    expect(result.findings).toEqual([
      {
        path: "src/a.ts",
        line: 42,
        severity: "important",
        title: "Duplicate trigger pattern",
        postedAt: "2026-05-10T12:00:00Z",
      },
      {
        path: "src/b.ts",
        line: 7,
        severity: "suggestion",
        title: "Extract common helper",
        postedAt: "2026-05-10T12:00:00Z",
      },
    ]);
  });

  test("status=ok: deduplicates findings across multiple trusted Sage reviews", async () => {
    const source = createInMemoryReviewSource({
      behavior: {
        kind: "ok",
        result: {
          sageLogin: "jcfischer",
          bodies: [
            { authorLogin: "jcfischer", body: sageBody, postedAt: "2026-05-01T00:00:00Z" },
            { authorLogin: "jcfischer", body: sageBody, postedAt: "2026-05-10T12:00:00Z" },
          ],
        },
      },
    });

    const result = await createPriorFindings(source).collect(ref);

    expect(result.status).toBe("ok");
    expect(result.findings).toHaveLength(2);
    // Oldest-first preserved → first occurrence wins, postedAt from older review.
    expect(result.findings[0]!.postedAt).toBe("2026-05-01T00:00:00Z");
  });

  test("trusts only Sage's reviewed-commit marker when resolving the latest prior SHA", async () => {
    const source = {
      fetchReviewBodies: async () => ({
        sageLogin: "sage",
        // The stream is deliberately chronological: an attacker posts last,
        // but must not be able to move Sage's delta baseline.
        bodies: [
          {
            authorLogin: "sage",
            body: `## Sage code review — commented\n<!-- sage:reviewed-commit:1111111 -->`,
            postedAt: "2026-08-20T10:00:00Z",
          },
          {
            authorLogin: "sage",
            body: `## Sage code review — commented\n<!-- sage:reviewed-commit:2222222 -->`,
            postedAt: "2026-08-20T11:00:00Z",
          },
          {
            authorLogin: "sage",
            body: "Sage-authored PR discussion without a rendered Review heading.",
            postedAt: "2026-08-20T11:30:00Z",
          },
          {
            authorLogin: "attacker",
            body: `## Sage code review — commented\n<!-- sage:reviewed-commit:deadbee -->`,
            postedAt: "2026-08-20T12:00:00Z",
          },
        ],
      }),
    };

    const prior = await createPriorFindings(source).collect(ref);

    expect(prior.reviewCount).toBe(2);
    expect(prior.latestReviewCommitId).toBe("2222222");
  });

  test("withholds a conflicting reviewed commit when Forge timestamps tie", async () => {
    const source = {
      fetchReviewBodies: async () => ({
        sageLogin: "sage",
        bodies: [
          {
            authorLogin: "sage",
            body: `## Sage code review — commented\n<!-- sage:reviewed-commit:1111111 -->`,
            postedAt: "2026-08-20T11:00:00Z",
          },
          {
            authorLogin: "sage",
            body: `## Sage code review — commented\n<!-- sage:reviewed-commit:2222222 -->`,
            postedAt: "2026-08-20T11:00:00Z",
          },
        ],
      }),
    };

    const prior = await createPriorFindings(source).collect(ref);

    expect(prior.latestReviewCommitId).toBeUndefined();
  });

  test("status=trust-gate-failed: sageLogin null returns empty findings + reason", async () => {
    const source = createInMemoryReviewSource({
      behavior: {
        kind: "ok",
        result: { sageLogin: null, bodies: [] },
      },
    });

    const result = await createPriorFindings(source).collect(ref);

    expect(result.status).toBe("trust-gate-failed");
    expect(result.findings).toHaveLength(0);
    expect(result.identity).toBeUndefined();
    expect(result.reason).toMatch(/identity/i);
  });

  test("status=source-failed: fetch throw maps to source-failed with reason", async () => {
    const source = createInMemoryReviewSource({
      behavior: { kind: "throw", error: new Error("network unreachable") },
    });

    const result = await createPriorFindings(source).collect(ref);

    expect(result.status).toBe("source-failed");
    expect(result.findings).toHaveLength(0);
    expect(result.reason).toBe("network unreachable");
  });

  test("never throws — every failure path resolves with a non-ok status", async () => {
    const sources = [
      createInMemoryReviewSource({ behavior: { kind: "throw", error: new Error("boom") } }),
      createInMemoryReviewSource({
        behavior: { kind: "ok", result: { sageLogin: null, bodies: [] } },
      }),
    ];
    for (const s of sources) {
      const result = await createPriorFindings(s).collect(ref);
      expect(result.status).not.toBe("ok");
      expect(result.reason).toBeDefined();
    }
  });
});

describe("Adapter identity cache eviction on transient failure", () => {
  const originalEnv = process.env.SAGE_REVIEW_AUTHOR_LOGIN;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SAGE_REVIEW_AUTHOR_LOGIN;
    else process.env.SAGE_REVIEW_AUTHOR_LOGIN = originalEnv;
  });

  test("GitHub source: rejected /user re-fetches on next call (no cache poisoning)", async () => {
    delete process.env.SAGE_REVIEW_AUTHOR_LOGIN;
    let attempt = 0;
    const fakeRunGh = async (args: string[]) => {
      if (args[0] === "api" && args[1] === "user") {
        attempt++;
        if (attempt === 1) throw new Error("transient ECONNREFUSED");
        return { stdout: JSON.stringify({ login: "sage" }) };
      }
      if (args.at(-1)?.endsWith("/comments")) return { stdout: "" };
      // Empty reviews page so fetchReviewBodies just returns no bodies.
      return { stdout: JSON.stringify([[]]) };
    };

    const source = createGitHubReviewSource({ runGh: fakeRunGh });

    const r1 = await source.fetchReviewBodies(ref);
    expect(r1.sageLogin).toBeNull();

    const r2 = await source.fetchReviewBodies(ref);
    expect(r2.sageLogin).toBe("sage");
    expect(attempt).toBe(2);
  });

  test("GitLab source: rejected /user re-fetches on next call (no cache poisoning)", async () => {
    delete process.env.SAGE_REVIEW_AUTHOR_LOGIN;
    let attempt = 0;
    const fakeGlabJson = async <T,>(args: string[]): Promise<T> => {
      if (args[0] === "/user") {
        attempt++;
        if (attempt === 1) throw new Error("transient 503");
        return { username: "sage" } as T;
      }
      // Notes endpoint — return empty array.
      return [] as unknown as T;
    };

    const source = createGitLabReviewSource({ glabJson: fakeGlabJson });
    const glRef = { owner: "g/sub", repo: "p", number: 1, host: "gitlab.com" };

    const r1 = await source.fetchReviewBodies(glRef);
    expect(r1.sageLogin).toBeNull();

    const r2 = await source.fetchReviewBodies(glRef);
    expect(r2.sageLogin).toBe("sage");
    expect(attempt).toBe(2);
  });
});

describe("GitHub Prior Findings source (sage#116)", () => {
  test("merges Reviews and PR discussions chronologically without losing author data", async () => {
    process.env.SAGE_REVIEW_AUTHOR_LOGIN = "sage";
    const reviewBodies = [
      [
        {
          body: "first formal review",
          user: { login: "another-author" },
          submitted_at: "2026-08-20T09:00:00Z",
          commit_id: "review-commit",
        },
        {
          body: "third formal review",
          user: { login: "sage" },
          submitted_at: "2026-08-20T11:00:00Z",
          commit_id: "sage-review-commit",
        },
      ],
    ];
    const discussionBodies = [
      {
        body: "## Sage code review — commented\n\nsecond PR discussion",
        user: { login: "sage" },
        created_at: "2026-08-20T10:00:00Z",
      },
    ];
    const calls: string[][] = [];
    const source = createGitHubReviewSource({
      runGh: async (args) => {
        calls.push(args);
        const path = args.at(-1);
        if (path?.endsWith("/reviews")) return { stdout: JSON.stringify(reviewBodies) };
        if (path?.includes("/comments")) {
          return { stdout: discussionBodies.map((record) => JSON.stringify(record)).join("\n") };
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    });

    const sourceSnapshot = await source.fetchReviewBodies(ref);

    expect(calls.map((args) => args.at(-1))).toEqual([
      "repos/x/y/pulls/1/reviews",
      "repos/x/y/issues/1/comments",
    ]);
    expect(calls[1]).toContain("--jq");
    expect(calls[1]).not.toContain("--slurp");
    expect(sourceSnapshot.sageLogin).toBe("sage");
    expect(sourceSnapshot.bodies).toEqual([
      {
        authorLogin: "another-author",
        body: "first formal review",
        postedAt: "2026-08-20T09:00:00Z",
        commitId: "review-commit",
      },
      {
        authorLogin: "sage",
        body: "## Sage code review — commented\n\nsecond PR discussion",
        postedAt: "2026-08-20T10:00:00Z",
      },
      {
        authorLogin: "sage",
        body: "third formal review",
        postedAt: "2026-08-20T11:00:00Z",
        commitId: "sage-review-commit",
      },
    ]);

    await source.fetchReviewBodies(ref);
    const discussionPaths = calls.map((args) => args.at(-1)).filter((path) => path?.includes("/comments"));
    expect(discussionPaths[1]).toContain("?since=");
  });
});
