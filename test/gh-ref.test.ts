import { describe, test, expect } from "bun:test";
import { parsePrRef, formatRepo } from "../src/github/gh.ts";

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
