import { describe, expect, mock, test } from "bun:test";
import { makeStubForge } from "./forge-stub.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";
import { honestOracleApplies } from "../src/lenses/applicability.ts";
import { parseSageCheckedClaims } from "../src/forge/prior-findings.ts";
import { createPriorFindings } from "../src/prior-findings/index.ts";
import {
  digestClaims,
  parseCheckedClaimsMarker,
  renderCheckedClaimsMarker,
} from "../src/util/claims.ts";

/**
 * sage#107 — the HonestOracle's PR-description trigger.
 *
 * Every other trigger reads the diff and settles once its subject stops
 * changing. This one reads `pr.body`, which is in no diff and GROWS on exactly
 * the rounds where it should quiet down, because answering a reviewer makes a
 * description longer. Unconditional, it is a full-diff model call every round
 * for the life of the PR.
 *
 * Firing only on round 1 would be the cheap fix and the wrong one: claims
 * introduced DURING a loop are the ones an author is least able to catch alone.
 * So the question is "are these claims unchecked?", not "is this round 1?".
 */

// Over the predicate's 80-character floor, and shaped like the overclaim the
// Oracle exists to catch ("guarantees", "fully").
const LONG_BODY =
  "This change guarantees that every write is atomic, and fully removes the legacy retry path.";

describe("claims digest", () => {
  test("survives reflowing, but not a changed word", () => {
    expect(digestClaims("one   two\n three")).toBe(digestClaims("one two three"));
    expect(digestClaims("must happen")).not.toBe(digestClaims("MUST happen"));
    expect(digestClaims("a claim")).not.toBe(digestClaims("a different claim"));
  });

  test("round-trips through the rendered review body", () => {
    const digest = digestClaims(LONG_BODY);
    expect(parseCheckedClaimsMarker(renderCheckedClaimsMarker(digest))).toBe(digest);
  });

  test("a review body with no marker reports nothing checked", () => {
    expect(parseSageCheckedClaims("## Sage code review — approved\n\nNo findings.")).toBeUndefined();
    // Not a Sage review body at all.
    expect(parseSageCheckedClaims(renderCheckedClaimsMarker("0".repeat(16)))).toBeUndefined();
  });
});

describe("honestOracleApplies", () => {
  const pr = (body: string, files: { path: string }[] = [{ path: "src/a.ts" }]) => ({
    pr: { body, files } as never,
    diff: "",
  });

  test("unchecked claims fire it — including when nothing is known yet", () => {
    expect(honestOracleApplies(pr(LONG_BODY))).toBe(true);
    expect(honestOracleApplies({ ...pr(LONG_BODY), claimsChanged: true })).toBe(true);
  });

  test("claims a prior review already checked do not fire it", () => {
    expect(honestOracleApplies({ ...pr(LONG_BODY), claimsChanged: false })).toBe(false);
  });

  test("docs in the change fire it regardless of the description", () => {
    // This branch settles on its own — the file list is narrowed to the delta
    // (sage#111), so a round touching no markdown does not reach it.
    expect(
      honestOracleApplies({
        ...pr("", [{ path: "README.md" }]),
        claimsChanged: false,
      }),
    ).toBe(true);
  });

  test("a bare change with no claims never fires it", () => {
    expect(honestOracleApplies(pr("bump dep"))).toBe(false);
  });
});

describe("prior findings carry the last checked claims", () => {
  const sageBody = (marker?: string) =>
    `## Sage code review — commented\n\nNo findings.\n\n---\n_Posted by Sage._${marker ? `\n${marker}` : ""}`;

  async function collectFrom(bodies: { body: string }[]) {
    return createPriorFindings({
      fetchReviewBodies: async () => ({
        sageLogin: "sage",
        bodies: bodies.map((b) => ({
          authorLogin: "sage",
          body: b.body,
          postedAt: "2026-08-01T00:00:00Z",
        })),
      }),
    } as never).collect({ owner: "x", repo: "y", number: 1 });
  }

  test("reports the digest the most recent checking review recorded", async () => {
    const first = renderCheckedClaimsMarker(digestClaims("old claims"));
    const second = renderCheckedClaimsMarker(digestClaims(LONG_BODY));
    const result = await collectFrom([{ body: sageBody(first) }, { body: sageBody(second) }]);

    expect(result.latestCheckedClaimsDigest).toBe(digestClaims(LONG_BODY));
    expect(result.reviewCount).toBe(2);
  });

  test("a later review whose oracle did not run does not erase an earlier check", async () => {
    const checked = renderCheckedClaimsMarker(digestClaims(LONG_BODY));
    const result = await collectFrom([{ body: sageBody(checked) }, { body: sageBody() }]);

    expect(result.latestCheckedClaimsDigest).toBe(digestClaims(LONG_BODY));
  });

  test("no review ever checked claims reads as unknown, not unchanged", async () => {
    const result = await collectFrom([{ body: sageBody() }]);
    expect(result.latestCheckedClaimsDigest).toBeUndefined();
  });
});

describe("the verdict records only claims that were actually read", () => {
  async function reviewWith(opts: { oracleErrors: boolean }) {
    mock.module("../src/util/persistence.ts", () => ({
      persistVerdict: () => true,
      verdictFilePath: () => "/tmp/sage-test/x.md",
      safeRefSegment: (v: string) => v.replace(/[^a-zA-Z0-9._-]/g, "_"),
    }));
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    return reviewPr({
      ref: { owner: "x", repo: "y", number: 7 },
      forge: makeStubForge({
        pr: {
          number: 7,
          title: "t",
          baseRefName: "main",
          headRefName: "f",
          headRefOid: "head",
          author: { login: "a" },
          body: LONG_BODY,
          changedFiles: 1,
          files: [{ path: "src/a.ts", additions: 3, deletions: 0 }],
        },
        diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+const x = 1;\n",
      }),
      substrate: {
        name: "pi" as const,
        displayName: "pi.dev",
        bin: "pi",
        jsonExtractors: TEXT_EXTRACTORS,
        envRequirements: { namespaces: [], keys: [] },
        run: async (o: { systemPrompt?: string }) => {
          const isOracle = /running the HonestOracle lens/.test(o.systemPrompt ?? "");
          if (isOracle && opts.oracleErrors) {
            return { stdout: "I refuse to answer.", stderr: "", exitCode: 0, durationMs: 1 };
          }
          return {
            stdout: JSON.stringify({ summary: "ok", findings: [] }),
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          };
        },
      } as never,
    });
  }

  test("records the digest when the oracle read the claims", async () => {
    const { verdict } = await reviewWith({ oracleErrors: false });

    expect(verdict.checkedClaimsDigest).toBe(digestClaims(LONG_BODY));
  });

  test("records nothing when the oracle crashed — unread claims are not checked claims", async () => {
    const { verdict } = await reviewWith({ oracleErrors: true });

    expect(verdict.checkedClaimsDigest).toBeUndefined();
  });
});
