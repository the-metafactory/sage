import { describe, test, expect } from "bun:test";
import { selectForge } from "../src/forge/select.ts";

/**
 * Forge selection precedence (sage#43 Phase 4):
 *   1. `--forge` flag
 *   2. `SAGE_FORGE` env
 *   3. URL/shorthand detection from the ref
 *   4. Default github
 */

describe("selectForge", () => {
  test("flag wins over env, ref, default", () => {
    const sel = selectForge({
      flag: "gitlab",
      fromRef: "https://github.com/x/y/pull/1",
      env: { SAGE_FORGE: "github" },
    });
    expect(sel.kind).toBe("gitlab");
    expect(sel.source).toBe("flag");
  });

  test("env wins over ref + default when flag absent", () => {
    const sel = selectForge({
      fromRef: "https://github.com/x/y/pull/1",
      env: { SAGE_FORGE: "gitlab" },
    });
    expect(sel.kind).toBe("gitlab");
    expect(sel.source).toBe("env");
  });

  test("ref detection wins over default when flag + env absent", () => {
    const sel = selectForge({
      fromRef: "https://gitlab.com/g/p/-/merge_requests/3",
      env: {},
    });
    expect(sel.kind).toBe("gitlab");
    expect(sel.source).toBe("ref");
  });

  test("falls back to github default when no signals", () => {
    const sel = selectForge({ env: {} });
    expect(sel.kind).toBe("github");
    expect(sel.source).toBe("default");
  });

  test("rejects invalid flag", () => {
    expect(() => selectForge({ flag: "bitbucket", env: {} })).toThrow(/must be/);
  });

  test("rejects invalid env", () => {
    expect(() => selectForge({ env: { SAGE_FORGE: "gerrit" } })).toThrow(/must be/);
  });

  test("ref without recognizable form falls back to default", () => {
    const sel = selectForge({ fromRef: "some-random-string", env: {} });
    expect(sel.kind).toBe("github");
    expect(sel.source).toBe("default");
  });

  test("gitlab backend uses gitlabHost flag when supplied", () => {
    const sel = selectForge({
      flag: "gitlab",
      gitlabHost: "gitlab.example.com",
      env: {},
    });
    // The backend's host accessor is intentionally on the concrete
    // GitLabBackend class; cast through unknown to peek for the test.
    const backend = sel.backend as unknown as { defaultHost: string };
    expect(backend.defaultHost).toBe("gitlab.example.com");
  });

  test("gitlab backend falls back to SAGE_GITLAB_HOST env", () => {
    const sel = selectForge({
      flag: "gitlab",
      env: { SAGE_GITLAB_HOST: "gitlab.internal.example" },
    });
    const backend = sel.backend as unknown as { defaultHost: string };
    expect(backend.defaultHost).toBe("gitlab.internal.example");
  });

  test("gitlab backend default host when none supplied", () => {
    const sel = selectForge({ flag: "gitlab", env: {} });
    const backend = sel.backend as unknown as { defaultHost: string };
    expect(backend.defaultHost).toBe("gitlab.com");
  });
});
