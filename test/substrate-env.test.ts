import { describe, expect, test } from "bun:test";

import { buildSubstrateEnv } from "../src/substrate/env.ts";

describe("buildSubstrateEnv allow-list", () => {
  test("forwards provider keys + shell essentials", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: {
        PATH: "/usr/bin",
        HOME: "/tmp",
        ANTHROPIC_API_KEY: "sk-ant-x",
        OPENROUTER_API_KEY: "or-x",
        UNRELATED_VAR: "ignored",
      },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(env.OPENROUTER_API_KEY).toBe("or-x");
    expect(env.UNRELATED_VAR).toBeUndefined();
  });

  // pi.dev's `google` provider (its default) reads `GEMINI_API_KEY`.
  // Sage previously only forwarded `GOOGLE_API_KEY` /
  // `GOOGLE_GENERATIVE_AI_API_KEY`, so the key never reached pi and
  // operators saw "missing API key" errors despite having Gemini
  // configured. Forwarding all three names covers every documented
  // env-var shape.
  test.each(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"])(
    "forwards %s for Gemini",
    (key) => {
      const env = buildSubstrateEnv({
        substrate: "pi",
        parent: { [key]: "AIza-xxxx" },
      });
      expect(env[key]).toBe("AIza-xxxx");
    },
  );

  test.each(["AZURE_OPENAI_API_KEY", "CEREBRAS_API_KEY"])(
    "forwards %s (added in sage#post-16 cleanup)",
    (key) => {
      const env = buildSubstrateEnv({
        substrate: "pi",
        parent: { [key]: "secret" },
      });
      expect(env[key]).toBe("secret");
    },
  );

  test("forwards PI_* namespace only to pi substrate", () => {
    const pi = buildSubstrateEnv({
      substrate: "pi",
      parent: { PI_PROVIDER: "anthropic", CLAUDE_MODEL: "sonnet" },
    });
    expect(pi.PI_PROVIDER).toBe("anthropic");
    expect(pi.CLAUDE_MODEL).toBeUndefined();
  });

  test("forwards CLAUDE_* + ANTHROPIC_* namespace only to claude substrate", () => {
    const claude = buildSubstrateEnv({
      substrate: "claude",
      parent: { PI_PROVIDER: "anthropic", CLAUDE_MODEL: "sonnet" },
    });
    expect(claude.CLAUDE_MODEL).toBe("sonnet");
    expect(claude.PI_PROVIDER).toBeUndefined();
  });

  test("SAGE_ENV_DENY blocks otherwise-allowed keys", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: {
        OPENAI_API_KEY: "sk-leaked",
        SAGE_ENV_DENY: "OPENAI_API_KEY",
      },
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("SAGE_ENV_ALLOW extends allow-list", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: { MY_CUSTOM_TOKEN: "x", SAGE_ENV_ALLOW: "MY_CUSTOM_TOKEN" },
    });
    expect(env.MY_CUSTOM_TOKEN).toBe("x");
  });

  test("legacy PI_ENV_ALLOW / PI_ENV_DENY are still honored (back-compat)", () => {
    const allowed = buildSubstrateEnv({
      substrate: "pi",
      parent: { MY_CUSTOM_TOKEN: "x", PI_ENV_ALLOW: "MY_CUSTOM_TOKEN" },
    });
    expect(allowed.MY_CUSTOM_TOKEN).toBe("x");

    const denied = buildSubstrateEnv({
      substrate: "pi",
      parent: { OPENAI_API_KEY: "sk-leaked", PI_ENV_DENY: "OPENAI_API_KEY" },
    });
    expect(denied.OPENAI_API_KEY).toBeUndefined();
  });

  test("sage-internal keys never reach the substrate", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: {
        SAGE_DID: "did:mf:sage",
        SAGE_ORG: "metafactory",
        SAGE_SUBSTRATE: "pi",
        SAGE_ENV_ALLOW: "SAGE_DID,SAGE_ORG,SAGE_SUBSTRATE",
      },
    });
    expect(env.SAGE_DID).toBeUndefined();
    expect(env.SAGE_ORG).toBeUndefined();
    expect(env.SAGE_SUBSTRATE).toBeUndefined();
  });

  test("forwarding-policy keys never reach the substrate", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: {
        PI_ENV_ALLOW: "K1,K2",
        PI_ENV_DENY: "K3",
        SAGE_ENV_ALLOW: "K4",
        SAGE_ENV_DENY: "K5",
      },
    });
    expect(env.PI_ENV_ALLOW).toBeUndefined();
    expect(env.PI_ENV_DENY).toBeUndefined();
    expect(env.SAGE_ENV_ALLOW).toBeUndefined();
    expect(env.SAGE_ENV_DENY).toBeUndefined();
  });

  test("NODE_OPTIONS is sensitive — NOT forwarded by default", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: { NODE_OPTIONS: "--require=evil.js" },
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  test("NODE_OPTIONS forwarded when explicitly allowed via SAGE_ENV_ALLOW", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: {
        NODE_OPTIONS: "--require=evil.js",
        SAGE_ENV_ALLOW: "NODE_OPTIONS",
      },
    });
    expect(env.NODE_OPTIONS).toBe("--require=evil.js");
  });

  test("opts.deny strips even allow-listed keys", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: { OPENAI_API_KEY: "k" },
      deny: ["OPENAI_API_KEY"],
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("extra wins on conflict", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: { PATH: "/usr/bin" },
      extra: { PATH: "/opt/bin" },
    });
    expect(env.PATH).toBe("/opt/bin");
  });

  test("extra: undefined value deletes the key", () => {
    const env = buildSubstrateEnv({
      substrate: "pi",
      parent: { OPENAI_API_KEY: "k" },
      extra: { OPENAI_API_KEY: undefined },
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("ANTHROPIC_API_KEY is forwarded to both substrates (provider key)", () => {
    const pi = buildSubstrateEnv({
      substrate: "pi",
      parent: { ANTHROPIC_API_KEY: "sk-ant-x" },
    });
    const claude = buildSubstrateEnv({
      substrate: "claude",
      parent: { ANTHROPIC_API_KEY: "sk-ant-x" },
    });
    expect(pi.ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(claude.ANTHROPIC_API_KEY).toBe("sk-ant-x");
  });
});
