import { expect, test } from "bun:test";
import { reviewPr } from "../src/lenses/workflow.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";
import { createPriorFindings } from "../src/prior-findings/collect.ts";
import { renderVerdict } from "../src/verdict/render.ts";
import { renderVerdictBlock } from "../src/verdict/block.ts";
import { loadGlossaryIgnore } from "../src/repo-config.ts";
import { makeStubForge } from "./forge-stub.ts";

const ref = { owner: "example", repo: "test", number: 1 };
const pr = { number: 1, title: "fix", body: "", author: { login: "author" }, baseRefName: "main", headRefName: "fix", headRefOid: "abc123", changedFiles: 1, files: [{ path: "src/a.ts", additions: 1, deletions: 0 }] };
const diff = "+++ b/src/a.ts\n@@ -0,0 +1 @@\n+// Command and spawn\n";
const substrate = {
  name: "pi" as const, displayName: "pi.dev", bin: "pi", jsonExtractors: TEXT_EXTRACTORS,
  envRequirements: { namespaces: [], keys: [] },
  run: async () => ({ stdout: JSON.stringify({ result: "no lens data" }), stderr: "", exitCode: 0, durationMs: 1 }),
};

test("malformed Pi lens output is incomplete, comment-only, and cannot become a reviewed baseline", async () => {
  const events: string[] = [];
  const forge = makeStubForge({ pr, diff, postReview: async (input) => {
    events.push(input.event); return { posted: "comment", downgraded: false };
  } });
  const result = await reviewPr({ ref, forge, substrate, post: true });
  expect(result.verdict.decision).toBe("incomplete");
  expect(events).toEqual(["comment"]);
  const body = renderVerdict(result.verdict);
  expect(body).toContain("DID NOT RUN");
  expect(body).not.toContain("sage:reviewed-commit:");
  const block = renderVerdictBlock(result.verdict, result.blockMeta);
  expect(block).toContain('"verdict": "incomplete"');
  expect(block).toContain('"majors": 0');
  const prior = await createPriorFindings({ fetchReviewBodies: async () => ({ sageLogin: "sage", bodies: [{ authorLogin: "sage", body, commitId: "abc123" }] }) }).collect(ref);
  expect(prior.reviewCount).toBe(0);
  expect(prior.latestReviewCommitId).toBeUndefined();
});

test("base-branch glossary ignores reach deterministic and model lenses", async () => {
  const inputs: string[] = [];
  const forge = makeStubForge({ pr, diff, repoFile: async (path, opts) => {
    expect(opts?.refName).toBe("main");
    if (path === ".sage.yaml") return "glossary:\n  ignore: [Command]\n";
    if (path === "CONTEXT.md") return "**Action**: unit\n_Avoid_: Command, spawn\n";
    return null;
  } });
  const result = await reviewPr({ ref, forge, substrate: { ...substrate, run: async (input) => {
    inputs.push(input.stdin ?? "");
    return { stdout: '{"summary":"ok","findings":[]}', stderr: "", exitCode: 0, durationMs: 1 };
  } } });
  const glossary = result.verdict.lenses.find((lens) => lens.lens === "Glossary");
  expect(glossary?.findings).toHaveLength(1);
  expect(glossary?.findings[0]?.title).toContain('"spawn"');
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs.every((input) => input.includes('Repository glossary exemptions (.sage.yaml): ["command"]'))).toBe(true);
});

test("invalid glossary config fails visibly and missing config has no exemptions", async () => {
  const forge = makeStubForge({ pr, diff, repoFile: async () => "glossary:\n  ignore: Command" });
  await expect(loadGlossaryIgnore(forge, ref, "main")).rejects.toThrow("array of non-empty strings");
  expect(await loadGlossaryIgnore(makeStubForge({ pr, diff }), ref, "main")).toEqual([]);
});


test("legacy failed-lens reviews cannot advance the retry baseline", async () => {
  const prior = await createPriorFindings({ fetchReviewBodies: async () => ({
    sageLogin: "sage", bodies: [
      { authorLogin: "sage", body: "## Sage code review — approved", commitId: "old" },
      { authorLogin: "sage", body: "## Sage code review — changes-requested\n\n### Security — DID NOT RUN\n\nCoverage incomplete; re-run before merge.", commitId: "failed" },
    ],
  }) }).collect(ref);
  expect(prior.reviewCount).toBe(1);
  expect(prior.latestReviewCommitId).toBe("old");
});
