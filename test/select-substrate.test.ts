import { describe, expect, test } from "bun:test";

import { selectSubstrate } from "../src/substrate/select.ts";

describe("selectSubstrate resolution precedence", () => {
  test("CLI flag wins over env and config", () => {
    const out = selectSubstrate({
      flag: "claude",
      env: { SAGE_SUBSTRATE: "pi" },
      config: { substrate: { default: "pi" } },
    });
    expect(out.name).toBe("claude");
    expect(out.source).toBe("flag");
  });

  test("env wins over config when flag absent", () => {
    const out = selectSubstrate({
      env: { SAGE_SUBSTRATE: "claude" },
      config: { substrate: { default: "pi" } },
    });
    expect(out.name).toBe("claude");
    expect(out.source).toBe("env");
  });

  test("supports codex as an explicit substrate", () => {
    const out = selectSubstrate({
      flag: "codex",
      env: { SAGE_SUBSTRATE: "pi" },
      config: { substrate: { default: "claude" } },
    });
    expect(out.name).toBe("codex");
    expect(out.source).toBe("flag");
    expect(out.substrate.name).toBe("codex");
    expect(out.substrate.displayName).toBe("Codex CLI");
  });

  test("config wins over default when flag + env absent", () => {
    const out = selectSubstrate({
      env: {},
      config: { substrate: { default: "claude" } },
    });
    expect(out.name).toBe("claude");
    expect(out.source).toBe("config");
  });

  test("falls back to pi when nothing is set — preserves pre-#14 behavior", () => {
    const out = selectSubstrate({ env: {}, config: {} });
    expect(out.name).toBe("pi");
    expect(out.source).toBe("default");
  });

  test("unknown substrate throws", () => {
    expect(() => selectSubstrate({ flag: "cortex" })).toThrow(/unknown substrate/);
  });

  test("empty / whitespace-only flag is ignored, env wins", () => {
    const out = selectSubstrate({
      flag: "   ",
      env: { SAGE_SUBSTRATE: "claude" },
      config: {},
    });
    expect(out.name).toBe("claude");
    expect(out.source).toBe("env");
  });

  test("returns a usable Substrate instance with correct name + bin", () => {
    const piSel = selectSubstrate({ flag: "pi", env: {}, config: {} });
    expect(piSel.substrate.name).toBe("pi");
    expect(piSel.substrate.displayName).toBe("pi.dev");
    expect(piSel.substrate.bin).toBeTruthy();

    const claudeSel = selectSubstrate({ flag: "claude", env: {}, config: {} });
    expect(claudeSel.substrate.name).toBe("claude");
    expect(claudeSel.substrate.displayName).toBe("Claude Code");
    expect(claudeSel.substrate.bin).toBeTruthy();
  });

  test("config substrate-specific overrides are wired through", () => {
    const out = selectSubstrate({
      flag: "claude",
      env: {},
      config: {
        substrate: {
          default: "pi",
          claude: { bin: "/custom/path/claude", model: "claude-opus-4-7" },
        },
      },
    });
    expect(out.substrate.name).toBe("claude");
    expect(out.substrate.bin).toBe("/custom/path/claude");
  });

  test("codex config overrides are wired through", () => {
    const originalCodexBin = process.env.CODEX_BIN;
    delete process.env.CODEX_BIN;
    try {
      const out = selectSubstrate({
        flag: "codex",
        env: {},
        config: {
          substrate: {
            default: "pi",
            codex: { bin: "/custom/path/codex", model: "gpt-5.2" },
          },
        },
      });
      expect(out.substrate.name).toBe("codex");
      expect(out.substrate.bin).toBe("/custom/path/codex");
    } finally {
      if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = originalCodexBin;
    }
  });

  test("case-insensitive normalization", () => {
    const out = selectSubstrate({ flag: "CLAUDE", env: {}, config: {} });
    expect(out.name).toBe("claude");
  });
});
