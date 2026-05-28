import { describe, test, expect } from "bun:test";
import { parsePrRef, detectForgeKindFromRef } from "../src/forge/parse.ts";

/**
 * Top-level PR/MR ref parser — routes between the per-forge parsers
 * by URL shape + shorthand separator. Per-forge parsing rules are
 * covered by `test/gh-ref.test.ts` and `test/gitlab-ref.test.ts`;
 * this suite pins the dispatching layer's correctness.
 */

describe("detectForgeKindFromRef", () => {
  test("identifies github.com URLs", () => {
    expect(detectForgeKindFromRef("https://github.com/x/y/pull/1")).toBe("github");
  });

  test("identifies gitlab.com URLs", () => {
    expect(detectForgeKindFromRef("https://gitlab.com/x/y/-/merge_requests/1")).toBe("gitlab");
  });

  test("identifies self-hosted GitLab by /-/merge_requests/ path", () => {
    expect(
      detectForgeKindFromRef("https://forge.internal.example/g/p/-/merge_requests/5"),
    ).toBe("gitlab");
  });

  test("identifies GitHub /pull/ path even on enterprise-shaped hostnames", () => {
    expect(
      detectForgeKindFromRef("https://github.example.com/o/r/pull/2"),
    ).toBe("github");
  });

  test("identifies OWNER/REPO#N shorthand as github", () => {
    expect(detectForgeKindFromRef("the-metafactory/sage#12")).toBe("github");
  });

  test("identifies GROUP/PROJ!N shorthand as gitlab", () => {
    expect(detectForgeKindFromRef("the-metafactory/sage!12")).toBe("gitlab");
  });

  test("returns null on unrecognized input", () => {
    expect(detectForgeKindFromRef("not a ref")).toBeNull();
  });
});

describe("parsePrRef (top-level)", () => {
  test("routes github URL to GitHub parser", () => {
    expect(parsePrRef("https://github.com/x/y/pull/3")).toEqual({
      owner: "x",
      repo: "y",
      number: 3,
    });
  });

  test("routes gitlab URL to GitLab parser", () => {
    expect(parsePrRef("https://gitlab.com/g/p/-/merge_requests/4")).toEqual({
      kind: "gitlab",
      owner: "g",
      repo: "p",
      number: 4,
      host: "gitlab.com",
    });
  });

  test("routes OWNER/REPO#N shorthand to GitHub parser", () => {
    expect(parsePrRef("the-metafactory/sage#7")).toEqual({
      owner: "the-metafactory",
      repo: "sage",
      number: 7,
    });
  });

  test("routes GROUP/PROJ!N shorthand to GitLab parser", () => {
    expect(parsePrRef("the-metafactory/sage!7")).toEqual({
      kind: "gitlab",
      owner: "the-metafactory",
      repo: "sage",
      number: 7,
    });
  });

  test("honors an explicit GitLab hint for hash shorthand", () => {
    // Bare `g/p#3` would normally route to GitHub by separator. An
    // explicit GitLab hint comes from `--forge gitlab`, so tolerate
    // the operator's familiar PR shorthand and publish a GitLab MR.
    expect(parsePrRef("g/p#3", "gitlab")).toEqual({
      kind: "gitlab",
      owner: "g",
      repo: "p",
      number: 3,
    });
  });

  test("throws on unrecognized input", () => {
    expect(() => parsePrRef("garbage")).toThrow(/unrecognized PR\/MR/);
  });
});
