import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PiSubstrate } from "../src/substrate/pi.ts";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PI_BIN;
  delete process.env.PI_PROVIDER;
  delete process.env.PI_MODEL;
  delete process.env.PI_API_KEY;
  delete process.env.PI_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("PiSubstrate", () => {
  test("runs pi lean in print mode with provider, model, thinking, system prompt, prompt, and stdin", async () => {
    const bin = writeRecorder();
    const substrate = new PiSubstrate({ bin, provider: "spark", model: "longctx-think" });

    const raw = await substrate.run({
      prompt: "review this PR",
      systemPrompt: "return JSON only",
      thinking: "off",
      stdin: "large diff",
      timeoutMs: 5_000,
    });

    expect(raw.exitCode).toBe(0);
    const captured = JSON.parse(raw.stdout) as { argv: string[]; stdin: string };
    expect(captured.argv).toEqual([
      "-p",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--provider",
      "spark",
      "--model",
      "longctx-think",
      "--system-prompt",
      "return JSON only",
      "--thinking",
      "off",
      "review this PR",
    ]);
    expect(captured.stdin).toBe("large diff");
  });

  test("keeps built-in tools enabled — lenses read the repo through them", async () => {
    const substrate = new PiSubstrate({ bin: writeRecorder() });

    const raw = await substrate.run({ prompt: "review", timeoutMs: 5_000 });

    const captured = JSON.parse(raw.stdout) as { argv: string[] };
    expect(captured.argv).not.toContain("--no-tools");
    expect(captured.argv).not.toContain("--no-builtin-tools");
  });

  test("env provider and model win over config", async () => {
    process.env.PI_PROVIDER = "env-provider";
    process.env.PI_MODEL = "env-model";
    const substrate = new PiSubstrate({
      bin: writeRecorder(),
      provider: "config-provider",
      model: "config-model",
    });

    const raw = await substrate.run({ prompt: "review", timeoutMs: 5_000 });

    const captured = JSON.parse(raw.stdout) as { argv: string[] };
    expect(captured.argv).toContain("env-provider");
    expect(captured.argv).toContain("env-model");
    expect(captured.argv).not.toContain("config-provider");
    expect(captured.argv).not.toContain("config-model");
  });
});

function writeRecorder(): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-pi-test-"));
  tempDirs.push(dir);
  const path = join(dir, "pi-recorder");
  const source = `
#!/usr/bin/env bun
const chunks = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  stdin: Buffer.concat(chunks).toString("utf8"),
}));
`;
  writeFileSync(path, source.trimStart(), "utf8");
  chmodSync(path, 0o755);
  return path;
}

const tempDirs: string[] = [];
