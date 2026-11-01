import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGh, postReviewWithFallback } from "../src/forge/github/backend.ts";
import { reviewPr } from "../src/lenses/workflow.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";
import { ClaudeSubstrate } from "../src/substrate/claude.ts";
import { isTransientNetworkError, retryTransient } from "../src/util/retry.ts";
import { findGlossaryViolations, parseGlossary } from "../src/lenses/glossary.ts";
import { makeStubForge } from "./forge-stub.ts";

const dirs: string[] = [];
const originalGh = process.env.GH_BIN;
const originalClaude = process.env.CLAUDE_BIN;
afterEach(() => {
  if (originalGh === undefined) delete process.env.GH_BIN;
  else process.env.GH_BIN = originalGh;
  if (originalClaude === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = originalClaude;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-reliability-"));
  dirs.push(dir);
  return dir;
}
function failingGh(): void {
  const path = join(directory(), "gh");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '{"message":"Validation Failed","errors":["Cannot request changes on your own pull request"]}'\nprintf '%s\\n' 'gh: Unprocessable Entity (HTTP 422)' >&2\nexit 1\n`);
  chmodSync(path, 0o755);
  process.env.GH_BIN = path;
}

describe("review delivery regressions", () => {
  test("CLI rejects an unwritable output destination before authentication or model work", () => {
    const dir = directory();
    const output = join(dir, "not-a-directory");
    writeFileSync(output, "keep");
    const child = Bun.spawnSync([process.execPath, "src/cli/index.ts", "review", "example/fixture#7", "--output-dir", output], {
      cwd: join(import.meta.dir, ".."),
      env: { HOME: dir, PATH: process.env.PATH ?? "", GH_BIN: join(dir, "no-gh") },
    });
    expect(child.exitCode).toBe(2);
    expect(child.stderr.toString()).toContain("--output-dir");
    expect(readFileSync(output, "utf8")).toBe("keep");
    expect(existsSync(join(dir, ".config/sage/reviews"))).toBe(false);
  });

  test("CLI setup failure exits incomplete once without reading a PR or posting", () => {
    const dir = directory();
    const gh = join(dir, "gh");
    const calls = join(dir, "calls");
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`);
    chmodSync(gh, 0o755);
    const child = Bun.spawnSync([process.execPath, "src/cli/index.ts", "review", "example/fixture#7", "--substrate", "claude", "--post", "--output-dir", join(dir, "output")], {
      cwd: join(import.meta.dir, ".."),
      env: { HOME: dir, PATH: process.env.PATH ?? "", GH_BIN: gh, CLAUDE_BIN: join(dir, "missing-claude") },
    });
    expect(child.exitCode).toBe(2);
    expect(child.stderr.toString()).toContain("Set CLAUDE_BIN");
    expect(child.stderr.toString()).not.toContain("lens substrate/extraction failed");
    expect(child.stdout.toString()).toBe("");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["auth status"]);
  });

  test("CLI keeps default persistence best-effort and proceeds to authentication", () => {
    const dir = directory();
    mkdirSync(join(dir, ".config/sage"), { recursive: true });
    writeFileSync(join(dir, ".config/sage/reviews"), "keep");
    const child = Bun.spawnSync([process.execPath, "src/cli/index.ts", "review", "example/fixture#7"], {
      cwd: join(import.meta.dir, ".."),
      env: { HOME: dir, PATH: process.env.PATH ?? "", GH_BIN: join(dir, "no-gh") },
    });
    expect(child.exitCode).toBe(2);
    expect(child.stderr.toString()).toContain("continuing without guaranteed recovery files");
    expect(child.stderr.toString()).toContain("gh auth is not configured");
    expect(readFileSync(join(dir, ".config/sage/reviews"), "utf8")).toBe("keep");
  });

  test("Claude reports an unavailable executable before a review starts", async () => {
    process.env.CLAUDE_BIN = join(directory(), "missing-claude");
    await expect(new ClaudeSubstrate().preflight()).rejects.toThrow("Set CLAUDE_BIN");
  });

  test("Claude checks executable access without a model call and pins its resolved binary", async () => {
    const dir = directory();
    const bin = join(dir, "claude");
    const calls = join(dir, "calls");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${calls}'\nif [ "$1" = '--version' ]; then printf 'fixture version\\n'; else printf 'fixture response\\n'; fi\n`);
    chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const substrate = new ClaudeSubstrate();
    await substrate.preflight();
    process.env.CLAUDE_BIN = join(dir, "now-missing");
    const result = await substrate.run({ prompt: "fixture", timeoutMs: 2_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("fixture response");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["--version", "-p"]);
    await expect(substrate.preflight()).rejects.toThrow("Set CLAUDE_BIN");
  });

  test("retains GitHub validation JSON alongside generic stderr", async () => {
    failingGh();
    await expect(runGh(["api", "fixture"])).rejects.toThrow("Cannot request changes on your own pull request");
  });

  test("self-review fallback can see an error returned on stdout", async () => {
    failingGh();
    const calls: string[] = [];
    const result = await postReviewWithFallback("request-changes", async event => {
      calls.push(event);
      if (event !== "comment") await runGh(["api", "fixture"]);
    }, () => {});
    expect(calls).toEqual(["request-changes", "comment"]);
    expect(result).toEqual({ posted: "comment", downgraded: true });
  });

  test("stops secondary rate limiting instead of rapidly repeating a write", async () => {
    let calls = 0;
    await expect(retryTransient(async () => {
      calls++;
      throw new Error("HTTP 403: You have exceeded a secondary rate limit. Please retry later.");
    }, { baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow("secondary rate limit");
    expect(calls).toBe(1);
  });

  test("a 429 is a cooldown rather than an immediate network retry", () => {
    expect(isTransientNetworkError(new Error("HTTP 429 Too Many Requests"))).toBe(false);
  });

  test("persists a recoverable verdict in an explicitly writable directory", () => {
    const dir = directory();
    const output = join(dir, "output");
    const source = `import {verdictFilePath,persistVerdict} from './src/verdict/persist.ts';
      import {decideVerdict} from './src/verdict/decide.ts';
      const ref={owner:'example',repo:'fixture',number:7};
      const explicit=process.env.SAGE_REVIEWS_DIR+'/explicit';
      process.stdout.write(JSON.stringify({path:verdictFilePath(ref,'md'),saved:persistVerdict(ref,decideVerdict([]),'completed review'),explicitPath:verdictFilePath(ref,'md',explicit),explicitSaved:persistVerdict(ref,decideVerdict([]),'explicit review',explicit),env:process.env.SAGE_REVIEWS_DIR}));`;
    const child = Bun.spawnSync([process.execPath, "-e", source], {
      cwd: join(import.meta.dir, ".."),
      env: { HOME: dir, PATH: process.env.PATH ?? "", SAGE_REVIEWS_DIR: output },
    });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.path).toBe(join(output, "example-fixture-7.md"));
    expect(result.saved).toBe(true);
    expect(readFileSync(result.path, "utf8")).toBe("completed review");
    expect(result.explicitPath).toBe(join(output, "explicit/example-fixture-7.md"));
    expect(result.explicitSaved).toBe(true);
    expect(readFileSync(result.explicitPath, "utf8")).toBe("explicit review");
    expect(result.env).toBe(output);
  });

  test("failed substrate preflight runs once and prevents forge reads and model fanout", async () => {
    let checked = 0;
    let runs = 0;
    let reads = 0;
    const forge = makeStubForge({ pr: {}, diff: "" });
    forge.prView = async () => { reads++; throw new Error("must not read PR"); };
    const substrate = {
      name: "claude" as const, displayName: "Claude Code", bin: "missing-claude",
      envRequirements: { namespaces: [], keys: [] }, jsonExtractors: TEXT_EXTRACTORS,
      preflight: async () => { checked++; throw new Error("Claude executable unavailable; set CLAUDE_BIN"); },
      run: async () => { runs++; return { stdout: "", stderr: "", exitCode: 1, durationMs: 0 }; },
    };
    await expect(reviewPr({ ref: { owner: "x", repo: "y", number: 1 }, forge, substrate, post: false })).rejects.toThrow("CLAUDE_BIN");
    expect(checked).toBe(1);
    expect(reads).toBe(0);
    expect(runs).toBe(0);
  });
});

const glossary = parseGlossary("## Terms\n\n**Cortex runtime**: runtime.\n_Avoid_: node, host\n\n**Session**: execution.\n_Avoid_: run\n");
function diff(path: string, lines: string[]): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => "+" + line).join("\n")}\n`;
}
describe("glossary syntax regressions", () => {
  test("does not rewrite Node imports or source identifiers as domain prose", () => {
    expect(findGlossaryViolations(glossary, diff("src/research.ts", [
      'import { join } from "node:path";', 'const host = "simulated-owner";',
    ]))).toEqual([]);
  });
  test("does not rewrite executable YAML keys or generated lock/JSON records", () => {
    for (const path of [".github/workflows/check.yml", "bun.lock", "results.jsonl"]) {
      expect(findGlossaryViolations(glossary, diff(path, ['run: bun test', '{"node":"fixture"}']))).toEqual([]);
    }
  });
  test("does not reinterpret shebangs, directives or private fields as comments", () => {
    expect(findGlossaryViolations(glossary, diff("src/worker.ts", [
      "#!/usr/bin/env node", "#host = 1;", "#include <node>",
    ]))).toEqual([]);
  });
  test("still reports prose in Markdown and source comments", () => {
    for (const [path, text] of [["README.md", "The host starts a run."], ["src/worker.ts", "// The host starts a run."]]) {
      expect(findGlossaryViolations(glossary, diff(path ?? "", [text ?? ""]))).toHaveLength(2);
    }
  });
  test("trailing comments inside executable lines remain outside the deterministic prose scan", () => {
    expect(findGlossaryViolations(glossary, diff("src/worker.ts", ["work(); // The host starts a run."]))).toEqual([]);
  });
});
