import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeStubForge } from "./forge-stub.ts";
import { excludeFromDiff, loadReviewExclude } from "../src/repo-config.ts";
import { renderVerdict } from "../src/verdict/render.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";

const ref = { owner: "x", repo: "y", number: 42 };
const section = (path: string, marker: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${marker}\n`;
const code = section("src/x.ts", "REVIEWED_CODE");
const generated = section("src/generated.ts", "GENERATED_DATA");
const evidence = section("spikes/drum/evidence-a/log.txt", "EVIDENCE_LOG");
const diff = code + generated + evidence;
const patterns = ["src/generated.ts", "spikes/**/*evidence*/**"];
const pr = {
  number: 42,
  title: "test",
  baseRefName: "main",
  headRefName: "feat/x",
  headRefOid: "abc",
  author: { login: "alice" },
  body: "",
  changedFiles: 3,
  files: [
    { path: "src/x.ts", additions: 1, deletions: 0 },
    { path: "src/generated.ts", additions: 1, deletions: 0 },
    { path: "spikes/drum/evidence-a/log.txt", additions: 1, deletions: 0 },
  ],
};

describe("excludeFromDiff", () => {
  test("removes matching files and names them", () => {
    const result = excludeFromDiff(diff, patterns);
    expect(result.diff).toBe(code);
    expect(result.excludedPaths).toEqual(["src/generated.ts", "spikes/drum/evidence-a/log.txt"]);
  });

  test("no patterns leave the diff byte-identical", () => {
    expect(excludeFromDiff(diff, [])).toEqual({ diff, excludedPaths: [] });
  });

  test("a rename is excluded when either side matches", () => {
    const renamed = "diff --git a/src/generated.ts b/src/moved.ts\nsimilarity index 90%\n";
    expect(excludeFromDiff(renamed, patterns).excludedPaths).toEqual(["src/generated.ts"]);
  });
});

describe("loadReviewExclude", () => {
  const forgeWith = (raw: string | null, seen: unknown[] = []) =>
    makeStubForge({
      pr,
      diff,
      repoFile: async (path, opts) => {
        seen.push([path, opts?.refName]);
        return raw;
      },
    });

  test("reads .sage.yaml from the base revision only", async () => {
    const seen: unknown[] = [];
    const loaded = await loadReviewExclude(forgeWith("review:\n  exclude: [a/**]\n", seen), ref, "main");
    expect(loaded).toEqual(["a/**"]);
    expect(seen).toEqual([[".sage.yaml", "main"]]);
  });

  test("no file or no key excludes nothing", async () => {
    expect(await loadReviewExclude(forgeWith(null), ref, "main")).toEqual([]);
    expect(await loadReviewExclude(forgeWith("glossary:\n  ignore: [a]\n"), ref, "main")).toEqual([]);
  });

  test("invalid configuration fails rather than reviewing less", async () => {
    await expect(loadReviewExclude(forgeWith("review:\n  exclude: a/**\n"), ref, "main")).rejects.toThrow(
      /review\.exclude/,
    );
    await expect(loadReviewExclude(forgeWith("review:\n  exclude: ['']\n"), ref, "main")).rejects.toThrow(
      /review\.exclude/,
    );
  });
});

describe("renderVerdict", () => {
  test("names every excluded path", () => {
    const body = renderVerdict({
      decision: "approved",
      summary: "ok",
      lenses: [],
      excludedPaths: ["src/generated.ts", "spikes/a/evidence/b.txt"],
    });
    expect(body).toContain("2 file(s) excluded from review by `.sage.yaml`");
    expect(body).toContain("`src/generated.ts`");
    expect(body).toContain("`spikes/a/evidence/b.txt`");
  });

  test("says nothing when nothing was excluded", () => {
    expect(renderVerdict({ decision: "approved", summary: "ok", lenses: [] })).not.toContain("excluded from review");
  });
});

describe("reviewPr", () => {
  beforeEach(() => {
    mock.module("../src/verdict/persist.ts", () => ({
      persistVerdict: () => true,
      verdictFilePath: () => "/tmp/sage-test/x.md",
    }));
  });
  afterEach(() => mock.restore());

  const run = async (config: string | null, extra: Record<string, unknown> = {}) => {
    const prompts: string[] = [];
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref,
      post: false,
      forge: makeStubForge({ pr, diff, repoFile: async (p) => (p === ".sage.yaml" ? config : null), ...extra }),
      substrate: {
        name: "pi" as const,
        displayName: "pi.dev",
        bin: "pi",
        jsonExtractors: TEXT_EXTRACTORS,
        envRequirements: { namespaces: [], keys: [] },
        run: async (input: unknown) => {
          prompts.push(JSON.stringify(input));
          return { stdout: JSON.stringify({ summary: "ok", findings: [] }), stderr: "", exitCode: 0, durationMs: 1 };
        },
      },
    } as never);
    return { result, prompts };
  };

  test("no lens reads an excluded file, and the verdict says so", async () => {
    const { result, prompts } = await run("review:\n  exclude: ['src/generated.ts', 'spikes/**/*evidence*/**']\n");
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain("REVIEWED_CODE");
      expect(prompt).not.toContain("GENERATED_DATA");
      expect(prompt).not.toContain("EVIDENCE_LOG");
    }
    expect(renderVerdict(result.verdict)).toContain("`src/generated.ts`");
  });

  test("without config every lens reads the whole diff", async () => {
    const { result, prompts } = await run(null);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt).toContain("GENERATED_DATA");
    expect(renderVerdict(result.verdict)).not.toContain("excluded from review");
  });
});
