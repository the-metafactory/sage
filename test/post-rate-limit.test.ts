import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postReview } from "../src/forge/github/backend.ts";

const dirs: string[] = [];
const originalGh = process.env.GH_BIN;
afterEach(() => {
  if (originalGh === undefined) delete process.env.GH_BIN;
  else process.env.GH_BIN = originalGh;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rateLimitedGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-post-rate-limit-"));
  dirs.push(dir);
  const bin = join(dir, "gh");
  const calls = join(dir, "calls");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' call >> '${calls}'\nprintf '%s\\n' '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits","status":"403"}'\nprintf '%s\\n' 'gh: Forbidden (HTTP 403)' >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  process.env.GH_BIN = bin;
  return calls;
}

describe("GitHub review posting under secondary rate limits", () => {
  test("an inline-comment review is written once and surfaces the secondary rate limit", async () => {
    const calls = rateLimitedGh();
    await expect(postReview({
      ref: { owner: "example", repo: "fixture", number: 7 },
      event: "comment",
      body: "fixture review",
      comments: [{ path: "src/fixture.ts", line: 1, body: "fixture finding" }],
    })).rejects.toThrow("secondary rate limit");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["call"]);
  });
});
