import { describe, test, expect } from "bun:test";
import { parsePrRef, formatRepo, runGh } from "../src/forge/github/backend.ts";

describe("parsePrRef", () => {
  test("parses GitHub URL", () => {
    expect(parsePrRef("https://github.com/the-metafactory/sage/pull/2")).toEqual({
      owner: "the-metafactory",
      repo: "sage",
      number: 2,
    });
  });

  test("parses http URL", () => {
    expect(parsePrRef("http://github.com/x/y/pull/123")).toEqual({
      owner: "x",
      repo: "y",
      number: 123,
    });
  });

  test("parses OWNER/REPO#N", () => {
    expect(parsePrRef("the-metafactory/sage#2")).toEqual({
      owner: "the-metafactory",
      repo: "sage",
      number: 2,
    });
  });

  test("trims whitespace", () => {
    expect(parsePrRef("  the-metafactory/sage#2  ")).toEqual({
      owner: "the-metafactory",
      repo: "sage",
      number: 2,
    });
  });

  test("rejects garbage", () => {
    expect(() => parsePrRef("not a pr ref")).toThrow(/unrecognized PR reference/);
  });

  test("rejects URL without /pull/", () => {
    expect(() => parsePrRef("https://github.com/the-metafactory/sage")).toThrow();
  });
});

describe("formatRepo", () => {
  test("joins owner/repo", () => {
    expect(formatRepo({ owner: "the-metafactory", repo: "sage", number: 2 })).toBe(
      "the-metafactory/sage",
    );
  });
});

test("GH_BIN=rtk prefixes GitHub subcommands for the RTK transport", async () => {
  const original = process.env.GH_BIN;
  process.env.GH_BIN = "rtk";
  try {
    const result = await runGh(["--version"]);
    expect(result.exitCode).toBe(0);
  } finally {
    if (original === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = original;
  }
});
