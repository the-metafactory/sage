import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeSubstrate } from "../src/substrate/claude.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ClaudeSubstrate", () => {
  test("passes an explicit empty tool list through as --tools empty", async () => {
    const substrate = new ClaudeSubstrate({ bin: writeRecorder() });

    const raw = await substrate.run({
      prompt: "review",
      systemPrompt: "json only",
      tools: [],
      responseFormat: "json",
      timeoutMs: 5_000,
    });

    expect(raw.exitCode).toBe(0);
    const captured = JSON.parse(raw.stdout) as { argv: string[] };
    expect(captured.argv).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-session-persistence",
      "--no-chrome",
      "--tools",
      "",
      "--system-prompt",
      "json only",
      "--output-format",
      "json",
      "review",
    ]);
  });

  test("keeps the lean runtime when a caller explicitly allows selected tools", async () => {
    const substrate = new ClaudeSubstrate({ bin: writeRecorder() });

    const raw = await substrate.run({
      prompt: "review",
      tools: ["Read"],
      timeoutMs: 5_000,
    });

    const captured = JSON.parse(raw.stdout) as { argv: string[] };
    expect(captured.argv).toContain("--setting-sources");
    expect(captured.argv).toContain("--strict-mcp-config");
    expect(captured.argv).toContain("--no-session-persistence");
    expect(captured.argv).toContain("Read");
  });
});

function writeRecorder(): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-claude-test-"));
  tempDirs.push(dir);
  const path = join(dir, "claude-recorder");
  const source = `
#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));
`;
  writeFileSync(path, source.trimStart(), "utf8");
  chmodSync(path, 0o755);
  return path;
}
