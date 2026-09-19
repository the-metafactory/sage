import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];

function runLauncher(contents: string, mode = 0o600) {
  const home = mkdtempSync(join(tmpdir(), "sage-typesafe-launcher-"));
  homes.push(home);
  const configDir = join(home, ".config", "sage");
  mkdirSync(configDir, { recursive: true });
  const envPath = join(configDir, "typesafe.env");
  writeFileSync(envPath, contents);
  chmodSync(envPath, mode);
  return Bun.spawnSync(["bash", "bin/sage", "--help"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("TypeSafe launcher environment", () => {
  test("accepts a current-user mode-600 literal configuration", () => {
    const result = runLauncher([
      "SAGE_TYPESAFE_MODE=off",
      "SAGE_TYPESAFE_TIMEOUT_MS=10000",
      "SAGE_TYPESAFE_REPEATS=1",
      "TYPESAFE_API_KEY=dummy-test-key",
      "",
    ].join("\n"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage: sage");
  });

  test("refuses a group-readable configuration", () => {
    const result = runLauncher("SAGE_TYPESAFE_MODE=off\n", 0o640);

    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("owned by the current user with mode 600");
  });

  test("rejects shell content instead of executing it", () => {
    const marker = join(tmpdir(), `sage-typesafe-marker-${crypto.randomUUID()}`);
    const result = runLauncher(`SAGE_TYPESAFE_MODE=off\nEVIL=$(touch ${marker})\n`);

    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("unsupported key EVIL");
    expect(existsSync(marker)).toBe(false);
  });
});
