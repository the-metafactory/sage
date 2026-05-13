import { describe, test, expect } from "bun:test";
import { buildPiEnv } from "../src/pi/env.ts";

describe("buildPiEnv", () => {
  test("forwards shell essentials when present in parent", () => {
    const out = buildPiEnv({ parent: { PATH: "/usr/bin", HOME: "/h" } });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/h");
  });

  test("forwards provider keys", () => {
    const out = buildPiEnv({
      parent: { OPENROUTER_API_KEY: "k1", ANTHROPIC_API_KEY: "k2" },
    });
    expect(out.OPENROUTER_API_KEY).toBe("k1");
    expect(out.ANTHROPIC_API_KEY).toBe("k2");
  });

  test("strips non-allow-listed keys", () => {
    const out = buildPiEnv({
      parent: { AWS_SECRET_ROTATION_TOKEN: "leak", PATH: "/usr/bin" },
    });
    expect(out.AWS_SECRET_ROTATION_TOKEN).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  test("forwards PI_* prefix keys", () => {
    const out = buildPiEnv({
      parent: { PI_PROVIDER: "openrouter", PI_MODEL: "gemini-flash" },
    });
    expect(out.PI_PROVIDER).toBe("openrouter");
    expect(out.PI_MODEL).toBe("gemini-flash");
  });

  test("denies PI_ENV_ALLOW and PI_ENV_DENY from leaking to subprocess", () => {
    const out = buildPiEnv({
      parent: { PI_ENV_ALLOW: "K1,K2", PI_ENV_DENY: "K3" },
    });
    expect(out.PI_ENV_ALLOW).toBeUndefined();
    expect(out.PI_ENV_DENY).toBeUndefined();
  });

  test("NODE_OPTIONS is sensitive — NOT forwarded by default", () => {
    const out = buildPiEnv({
      parent: { NODE_OPTIONS: "--require /tmp/evil.js" },
    });
    expect(out.NODE_OPTIONS).toBeUndefined();
  });

  test("NODE_OPTIONS forwarded when explicitly allowed", () => {
    const out = buildPiEnv({
      parent: { NODE_OPTIONS: "--experimental-modules" },
      allow: ["NODE_OPTIONS"],
    });
    expect(out.NODE_OPTIONS).toBe("--experimental-modules");
  });

  test("NODE_OPTIONS forwarded via parent PI_ENV_ALLOW", () => {
    const out = buildPiEnv({
      parent: { NODE_OPTIONS: "--experimental-modules", PI_ENV_ALLOW: "NODE_OPTIONS" },
    });
    expect(out.NODE_OPTIONS).toBe("--experimental-modules");
  });

  test("opts.deny strips even allow-listed keys", () => {
    const out = buildPiEnv({
      parent: { OPENAI_API_KEY: "k" },
      deny: ["OPENAI_API_KEY"],
    });
    expect(out.OPENAI_API_KEY).toBeUndefined();
  });

  test("opts.extra overrides parent value", () => {
    const out = buildPiEnv({
      parent: { OPENAI_API_KEY: "from-parent" },
      extra: { OPENAI_API_KEY: "from-extra" },
    });
    expect(out.OPENAI_API_KEY).toBe("from-extra");
  });
});
