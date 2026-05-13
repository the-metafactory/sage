import { describe, test, expect } from "bun:test";
import {
  postReviewWithFallback,
  SELF_REVIEW_BLOCK_RE,
  type ReviewEvent,
} from "../src/github/gh.ts";

/**
 * Tests cover the fallback POLICY (postReviewWithFallback), not the gh
 * subprocess wrapper. The attempt function is the unit-under-isolation
 * boundary: we feed it scripted outcomes and assert what the policy does.
 *
 * Acceptance criteria from issue #4:
 *   (a) self-approve block → comment fallback succeeds
 *   (b) non-block failure does NOT trigger fallback
 *   (c) `--comment` failure does NOT loop back to itself
 */

function selfApproveError(): Error {
  // Mirror the actual gh stderr verbatim — the regex is the public
  // contract between gh and our policy.
  return new Error(
    "gh pr review 3 --repo the-metafactory/sage --approve --body-file /tmp/x failed (exit 1): " +
      "failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)",
  );
}

function selfRequestChangesError(): Error {
  return new Error(
    "failed to create review: GraphQL: Review Can not request changes on your own pull request (addPullRequestReview)",
  );
}

describe("SELF_REVIEW_BLOCK_RE", () => {
  test("matches the self-approve GraphQL block", () => {
    expect(SELF_REVIEW_BLOCK_RE.test(selfApproveError().message)).toBe(true);
  });

  test("matches the self-request-changes GraphQL block (symmetric family)", () => {
    expect(SELF_REVIEW_BLOCK_RE.test(selfRequestChangesError().message)).toBe(true);
  });

  test("does not match unrelated review errors", () => {
    expect(SELF_REVIEW_BLOCK_RE.test("HTTP 502 Bad Gateway from api.github.com")).toBe(false);
    expect(SELF_REVIEW_BLOCK_RE.test("401 Bad credentials")).toBe(false);
    expect(
      SELF_REVIEW_BLOCK_RE.test(
        "Validation Failed: Body is too long (maximum is 65536 characters)",
      ),
    ).toBe(false);
  });
});

describe("postReviewWithFallback", () => {
  test("(a) self-approve block → falls back to --comment, returns downgraded=true", async () => {
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      if (event === "approve") throw selfApproveError();
      return undefined;
    };
    const logs: string[] = [];

    const result = await postReviewWithFallback("approve", attempt, (m) => {
      logs.push(m);
    });

    expect(calls).toEqual(["approve", "comment"]);
    expect(result).toEqual({ posted: "comment", downgraded: true });
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/falling back to --comment/);
    expect(logs[0]).toContain("approve");
  });

  test("self-request-changes block → falls back to --comment (symmetric case)", async () => {
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      if (event === "request-changes") throw selfRequestChangesError();
      return undefined;
    };

    const result = await postReviewWithFallback("request-changes", attempt, () => {});

    expect(calls).toEqual(["request-changes", "comment"]);
    expect(result).toEqual({ posted: "comment", downgraded: true });
  });

  test("happy path: approve succeeds first try → no fallback, no log", async () => {
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      return undefined;
    };
    const logs: string[] = [];

    const result = await postReviewWithFallback("approve", attempt, (m) => {
      logs.push(m);
    });

    expect(calls).toEqual(["approve"]);
    expect(result).toEqual({ posted: "approve", downgraded: false });
    expect(logs).toEqual([]);
  });

  test("(b) non-block failure does NOT trigger fallback (e.g. 502 Bad Gateway)", async () => {
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      throw new Error("gh pr review failed (exit 1): HTTP 502 Bad Gateway from api.github.com");
    };

    await expect(postReviewWithFallback("approve", attempt, () => {})).rejects.toThrow(
      /502 Bad Gateway/,
    );
    expect(calls).toEqual(["approve"]);
  });

  test("(b) auth failure does NOT trigger fallback", async () => {
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      throw new Error("HTTP 401: Bad credentials");
    };

    await expect(postReviewWithFallback("request-changes", attempt, () => {})).rejects.toThrow(
      /401/,
    );
    expect(calls).toEqual(["request-changes"]);
  });

  test("(c) --comment failure does NOT loop back to itself", async () => {
    // If the verdict was 'commented' (event=comment) and the gh call fails
    // for any reason (including, hypothetically, a self-review block that
    // shouldn't happen for comment), we must NOT retry as comment again.
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      throw new Error("Validation Failed: body cannot be empty");
    };

    await expect(postReviewWithFallback("comment", attempt, () => {})).rejects.toThrow(
      /body cannot be empty/,
    );
    expect(calls).toEqual(["comment"]);
  });

  test("(c) defense in depth: comment-event with self-review-block-shaped error also does NOT loop", async () => {
    // Belt-and-suspenders — even if some upstream layer produced a
    // self-review-block error message while requesting `comment`, we
    // must not call comment a second time. Policy's `event !== "comment"`
    // guard enforces this.
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      throw selfApproveError();
    };

    await expect(postReviewWithFallback("comment", attempt, () => {})).rejects.toThrow();
    expect(calls).toEqual(["comment"]);
  });

  test("fallback comment failure propagates (no third attempt)", async () => {
    // Self-approve blocked → fallback to comment → comment also fails.
    // The comment error must propagate; we must not loop or swallow.
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      if (event === "approve") throw selfApproveError();
      throw new Error("HTTP 503 Service Unavailable");
    };

    await expect(postReviewWithFallback("approve", attempt, () => {})).rejects.toThrow(
      /503 Service Unavailable/,
    );
    expect(calls).toEqual(["approve", "comment"]);
  });

  test("non-Error throwables work too (defensive — gh wrapper always wraps in Error, but be robust)", async () => {
    const calls: ReviewEvent[] = [];
    const attempt = async (event: ReviewEvent) => {
      calls.push(event);
      if (event === "approve") {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "Can not approve your own pull request";
      }
      return undefined;
    };

    const result = await postReviewWithFallback("approve", attempt, () => {});

    expect(calls).toEqual(["approve", "comment"]);
    expect(result.downgraded).toBe(true);
  });

  test("default logger used when log arg omitted (smoke — no throw)", async () => {
    const attempt = async (event: ReviewEvent) => {
      if (event === "approve") throw selfApproveError();
      return undefined;
    };
    // Should not throw; default console.error logger is invoked.
    const result = await postReviewWithFallback("approve", attempt);
    expect(result.posted).toBe("comment");
  });
});
