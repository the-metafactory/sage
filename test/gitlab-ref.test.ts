import { describe, test, expect } from "bun:test";
import {
  parsePrRef,
  splitProjectPath,
  formatProjectPath,
} from "../src/forge/gitlab/backend.ts";

describe("parsePrRef (GitLab)", () => {
  test("parses gitlab.com MR URL", () => {
    expect(
      parsePrRef("https://gitlab.com/the-metafactory/sage/-/merge_requests/2"),
    ).toEqual({
      kind: "gitlab",
      owner: "the-metafactory",
      repo: "sage",
      number: 2,
      host: "gitlab.com",
    });
  });

  test("parses self-hosted MR URL", () => {
    expect(
      parsePrRef("https://gitlab.example.com/group/project/-/merge_requests/47"),
    ).toEqual({
      kind: "gitlab",
      owner: "group",
      repo: "project",
      number: 47,
      host: "gitlab.example.com",
    });
  });

  test("parses nested-group MR URL", () => {
    expect(
      parsePrRef("https://gitlab.com/group/sub/proj/-/merge_requests/3"),
    ).toEqual({
      kind: "gitlab",
      owner: "group/sub",
      repo: "proj",
      number: 3,
      host: "gitlab.com",
    });
  });

  test("parses GROUP/PROJ!N shorthand", () => {
    expect(parsePrRef("the-metafactory/sage!12")).toEqual({
      kind: "gitlab",
      owner: "the-metafactory",
      repo: "sage",
      number: 12,
    });
  });

  test("parses nested GROUP/SUB/PROJ!N shorthand", () => {
    expect(parsePrRef("group/sub/proj!5")).toEqual({
      kind: "gitlab",
      owner: "group/sub",
      repo: "proj",
      number: 5,
    });
  });

  test("rejects unrecognized input", () => {
    expect(() => parsePrRef("not a ref")).toThrow(/unrecognized GitLab MR reference/);
  });

  test("rejects GitHub-style ref", () => {
    // The `#` separator is GitHub-only; GitLab parser must not accept
    // it to avoid cross-forge ref smuggling.
    expect(() => parsePrRef("the-metafactory/sage#12")).toThrow();
  });

  test("rejects single-segment project shorthand", () => {
    // Every GitLab project lives under at least one namespace; a
    // bare-name shorthand cannot be addressed via the API.
    expect(() => parsePrRef("project!1")).toThrow(/at least 2 segments/);
  });
});

describe("splitProjectPath", () => {
  test("splits a 2-segment path", () => {
    expect(splitProjectPath("group/project")).toEqual({
      owner: "group",
      repo: "project",
    });
  });

  test("absorbs nested groups into owner", () => {
    expect(splitProjectPath("group/sub/sub2/project")).toEqual({
      owner: "group/sub/sub2",
      repo: "project",
    });
  });

  test("rejects single-segment path", () => {
    expect(() => splitProjectPath("orphan")).toThrow(/at least 2 segments/);
  });

  test("ignores leading/trailing slashes", () => {
    expect(splitProjectPath("/group/project/")).toEqual({
      owner: "group",
      repo: "project",
    });
  });
});

describe("formatProjectPath", () => {
  test("joins owner + repo with a slash", () => {
    expect(
      formatProjectPath({ kind: "gitlab", owner: "group", repo: "project", number: 1 }),
    ).toBe("group/project");
  });

  test("preserves nested groups", () => {
    expect(
      formatProjectPath({
        kind: "gitlab",
        owner: "group/sub",
        repo: "project",
        number: 1,
      }),
    ).toBe("group/sub/project");
  });
});
