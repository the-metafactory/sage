import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { GitLabBackend } from "../src/forge/gitlab/backend.ts";

/**
 * End-to-end-ish smoke test for the GitLab backend. Replaces the real
 * `glab` binary with `test/fixtures/glab-mock.sh` via the `GLAB_BIN`
 * env override exposed by `runGlab`. Exercises the full subprocess
 * spawn → stdout parse → mapping chain — coverage the mapping-only
 * tests in `gitlab-mapping.test.ts` skip past.
 *
 * Scope is intentionally narrow: prove that `glab api` invocation is
 * argv-shape correct, that JSON is parsed, and that GitLab-flavored
 * payloads map into the platform-neutral `PrMetadata` shape. Wider
 * permutations (auth-failure paths, rate-limit handling, pagination)
 * stay in the unit suites — those paths exercise `runGlab` error
 * handling that's already covered by the github backend's parallel
 * `runGh` tests, and the `buildGlabEnv` allow-list deliberately
 * excludes test-side env injection signals (sage#43 — env hijack
 * guard).
 */

const MOCK_PATH = resolve(import.meta.dir, "fixtures/glab-mock.sh");

beforeAll(() => {
  process.env.GLAB_BIN = MOCK_PATH;
  // The viewer-login cache keys on host; force a fresh state so we
  // don't accidentally read a value cached by a prior suite.
  delete process.env.SAGE_REVIEW_AUTHOR_LOGIN;
});

describe("GitLabBackend (integration with mock glab)", () => {
  const backend = new GitLabBackend();
  const ref = {
    kind: "gitlab" as const,
    owner: "group",
    repo: "proj",
    number: 7,
    host: "gitlab.com",
  };

  test("authStatus succeeds via mock auth subcommand", async () => {
    const status = await backend.authStatus();
    expect(status.ok).toBe(true);
    expect(status.output).toContain("Logged in");
  });

  test("prView fetches + maps a GitLab MR into PrMetadata", async () => {
    const pr = await backend.prView(ref);
    expect(pr.number).toBe(7);
    expect(pr.title).toBe("feat: add cool thing");
    expect(pr.state).toBe("open"); // normalized from "opened"
    expect(pr.author.login).toBe("alice");
    expect(pr.baseRefName).toBe("main");
    expect(pr.headRefName).toBe("feat/cool");
    expect(pr.url).toBe("https://gitlab.com/group/proj/-/merge_requests/7");
    expect(pr.changedFiles).toBe(1);
    expect(pr.files[0]?.path).toBe("src/a.ts");
  });

  test("prDiff stitches per-file diffs from /changes endpoint", async () => {
    const diff = await backend.prDiff(ref);
    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff).toContain("+new");
    expect(diff).toContain("-old");
  });

  test("postReview comment posts a single notes POST", async () => {
    const result = await backend.postReview({
      ref,
      event: "comment",
      body: "review body",
    });
    expect(result).toEqual({ posted: "comment", downgraded: false });
  });

  test("postReview approve hits both /approve and /notes", async () => {
    const result = await backend.postReview({
      ref,
      event: "approve",
      body: "lgtm",
    });
    expect(result).toEqual({ posted: "approve", downgraded: false });
  });
});
