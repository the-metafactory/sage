import { describe, test, expect } from "bun:test";
import { buildGlabEnv, GLAB_AUTH_KEYS } from "../src/forge/gitlab/env.ts";

describe("buildGlabEnv", () => {
  test("forwards shell essentials and allow-listed auth keys", () => {
    const env = buildGlabEnv({
      parent: {
        PATH: "/usr/bin",
        HOME: "/home/u",
        GITLAB_TOKEN: "secret",
        GLAB_CONFIG_DIR: "/c",
        TZ: "UTC",
      },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GITLAB_TOKEN).toBe("secret");
    expect(env.GLAB_CONFIG_DIR).toBe("/c");
  });

  test("does NOT forward GITLAB_HOST (security: prevents host hijack)", () => {
    // glab's documented precedence puts $GITLAB_HOST above --hostname,
    // so a parent env GITLAB_HOST could redirect a self-hosted review
    // to a different instance. The allow-list excludes it explicitly.
    const env = buildGlabEnv({
      parent: {
        PATH: "/usr/bin",
        GITLAB_TOKEN: "secret",
        GITLAB_HOST: "gitlab.evil.example.com",
      },
    });
    expect(env.GITLAB_HOST).toBeUndefined();
    expect(GLAB_AUTH_KEYS).not.toContain("GITLAB_HOST");
  });

  test("does NOT forward unrelated keys (no leak of provider API tokens)", () => {
    const env = buildGlabEnv({
      parent: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "should-not-leak",
        OPENAI_API_KEY: "should-not-leak",
      },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("extra overrides parent forwarding", () => {
    const env = buildGlabEnv({
      parent: { PATH: "/usr/bin", GITLAB_TOKEN: "parent-token" },
      extra: { GITLAB_TOKEN: "override-token" },
    });
    expect(env.GITLAB_TOKEN).toBe("override-token");
  });

  test("extra=undefined deletes a key", () => {
    const env = buildGlabEnv({
      parent: { PATH: "/usr/bin", GITLAB_TOKEN: "parent-token" },
      extra: { GITLAB_TOKEN: undefined },
    });
    expect(env.GITLAB_TOKEN).toBeUndefined();
  });
});
