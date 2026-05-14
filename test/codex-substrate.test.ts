import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CodexSubstrate } from "../src/substrate/codex.ts";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CODEX_BIN;
  delete process.env.CODEX_MODEL;
  delete process.env.CODEX_PROFILE;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CODEX_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("CodexSubstrate", () => {
  test("runs codex exec non-interactively with read-only sandbox, prompt, system prompt, model, and stdin", async () => {
    const bin = writeRecorder();
    const substrate = new CodexSubstrate({ bin, model: "config-model" });

    const raw = await substrate.run({
      prompt: "review this PR",
      systemPrompt: "return JSON only",
      stdin: "large diff",
      timeoutMs: 5_000,
    });

    expect(raw.exitCode).toBe(0);
    const captured = JSON.parse(raw.stdout) as { argv: string[]; stdin: string };
    expect(captured.argv).toEqual([
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--model",
      "config-model",
      "System instructions:\nreturn JSON only\n\nUser task:\nreview this PR",
    ]);
    expect(captured.stdin).toBe("large diff");
  });

  test("per-call model wins over env and config", async () => {
    process.env.CODEX_MODEL = "env-model";
    const bin = writeRecorder();
    const substrate = new CodexSubstrate({ bin, model: "config-model" });

    const raw = await substrate.run({
      prompt: "review",
      model: "call-model",
      timeoutMs: 5_000,
    });

    const captured = JSON.parse(raw.stdout) as { argv: string[] };
    expect(captured.argv).toContain("call-model");
    expect(captured.argv).not.toContain("env-model");
    expect(captured.argv).not.toContain("config-model");
  });

  test("env profile and sandbox are wired into codex exec", async () => {
    process.env.CODEX_PROFILE = "reviewer";
    process.env.CODEX_SANDBOX = "workspace-write";
    const bin = writeRecorder();
    const substrate = new CodexSubstrate({ bin });

    const raw = await substrate.run({
      prompt: "review",
      timeoutMs: 5_000,
    });

    const captured = JSON.parse(raw.stdout) as { argv: string[] };
    expect(captured.argv).toEqual([
      "exec",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "--profile",
      "reviewer",
      "review",
    ]);
  });

  test("invalid CODEX_SANDBOX fails before spawning", async () => {
    process.env.CODEX_SANDBOX = "seatbelt";
    const substrate = new CodexSubstrate({ bin: writeRecorder() });

    await expect(
      substrate.run({
        prompt: "review",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/invalid CODEX_SANDBOX/);
  });

  test("invalid config sandbox fails before spawning", async () => {
    const substrate = new CodexSubstrate({
      bin: writeRecorder(),
      sandbox: "seatbelt" as never,
    });

    await expect(
      substrate.run({
        prompt: "review",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/invalid codex sandbox config/);
  });

  test("CODEX_SANDBOX trims surrounding whitespace", async () => {
    process.env.CODEX_SANDBOX = " workspace-write ";
    const bin = writeRecorder();
    const substrate = new CodexSubstrate({ bin });

    const raw = await substrate.run({
      prompt: "review",
      timeoutMs: 5_000,
    });

    const captured = JSON.parse(raw.stdout) as { argv: string[] };
    expect(captured.argv).toContain("workspace-write");
    expect(captured.argv).not.toContain(" workspace-write ");
  });

  test("runJson extracts lens-shaped JSON from codex output", async () => {
    const bin = writeJsonResponder();
    const substrate = new CodexSubstrate({ bin });

    const { result } = await substrate.runJson<{ summary: string; findings: unknown[] }>({
      prompt: "review",
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ summary: "ok", findings: [] });
  });
});

function writeRecorder(): string {
  return writeExecutable(`
#!/usr/bin/env bun
const chunks = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  stdin: Buffer.concat(chunks).toString("utf8"),
}));
`);
}

function writeJsonResponder(): string {
  return writeExecutable(`
#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ summary: "ok", findings: [] }));
`);
}

function writeExecutable(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-codex-test-"));
  tempDirs.push(dir);
  const path = join(dir, "codex-recorder");
  writeFileSync(path, source.trimStart(), "utf8");
  chmodSync(path, 0o755);
  return path;
}

const tempDirs: string[] = [];
