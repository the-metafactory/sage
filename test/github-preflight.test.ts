import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "sage-preflight-"));
  dirs.push(dir);
  return dir;
}

const GH_AUTH_STATUS_MISLABEL = [
  "github.com",
  "  X Failed to log in to github.com account fixture-login",
  "  - Active account: true",
  "  - The token is invalid.",
].join("\n");

interface ApiStub {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

function response(status: string, headers: Record<string, string>, body: string): string {
  const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  return `HTTP/2.0 ${status}\n${headerLines}\r\n${body}\n`;
}

function runReview(api: ApiStub) {
  const dir = directory();
  const stdoutFile = join(dir, "api.stdout");
  const stderrFile = join(dir, "api.stderr");
  const authFile = join(dir, "auth.text");
  const calls = join(dir, "calls");
  writeFileSync(stdoutFile, api.stdout ?? "");
  writeFileSync(stderrFile, api.stderr ?? "");
  writeFileSync(authFile, GH_AUTH_STATUS_MISLABEL + "\n");
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
if [ "$1" = auth ]; then cat '${authFile}'; exit 1; fi
cat '${stdoutFile}'
cat '${stderrFile}' >&2
exit ${api.exit ?? 1}
`);
  chmodSync(gh, 0o755);
  const child = Bun.spawnSync(
    [process.execPath, "src/cli/index.ts", "review", "example/fixture#7", "--output-dir", join(dir, "output")],
    {
      cwd: join(import.meta.dir, ".."),
      env: { HOME: dir, PATH: process.env.PATH ?? "", GH_BIN: gh, CLAUDE_BIN: join(dir, "missing-claude") },
    },
  );
  return {
    exitCode: child.exitCode,
    stderr: child.stderr.toString(),
    stdout: child.stdout.toString(),
    calls: () => readFileSync(calls, "utf8").trim().split("\n"),
  };
}

const MARKER = "SAGE_PREFLIGHT_FAILURE ";

/** What ranger's `sageReview` keeps of a failed run: the last 400 characters of stderr. */
function markerSeenByRanger(stderr: string): Record<string, unknown> {
  const lastLine = stderr.trim().slice(-400).split("\n").at(-1) ?? "";
  expect(lastLine.startsWith(MARKER)).toBe(true);
  return JSON.parse(lastLine.slice(MARKER.length)) as Record<string, unknown>;
}

const NOT_CONFIGURED = "gh auth is not configured";

describe("sage review GitHub preflight", () => {
  test("a primary rate limit is a rate-limit failure carrying the reset time", () => {
    const run = runReview({
      stdout: response("403 Forbidden", {
        "X-Ratelimit-Limit": "5000",
        "X-Ratelimit-Remaining": "0",
        "X-Ratelimit-Reset": "1794175200",
      }, '{"message":"API rate limit exceeded for user ID 1."}'),
      stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n",
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).not.toContain(NOT_CONFIGURED);
    expect(run.stderr).not.toContain("gh auth login");
    expect(markerSeenByRanger(run.stderr)).toEqual({
      kind: "rate-limit",
      http_status: 403,
      reset_at: new Date(1794175200 * 1000).toISOString(),
    });
  });

  test("a secondary limit is recognised while the core budget is untouched, and resets from retry-after", () => {
    const before = Date.now();
    const run = runReview({
      stdout: response("403 Forbidden", {
        "Retry-After": "60",
        "X-Ratelimit-Remaining": "4999",
        "X-Ratelimit-Reset": "1794175200",
      }, '{"message":"You have exceeded a secondary rate limit."}'),
    });
    const marker = markerSeenByRanger(run.stderr);
    expect(marker.kind).toBe("rate-limit");
    const resetAt = Date.parse(String(marker.reset_at));
    expect(resetAt).toBeGreaterThanOrEqual(before + 59_000);
    expect(resetAt).toBeLessThan(Date.now() + 61_000);
  });

  test("a secondary limit known only by its message does not borrow the core budget's reset", () => {
    const run = runReview({
      stdout: response("403 Forbidden", {
        "X-Ratelimit-Remaining": "4999",
        "X-Ratelimit-Reset": "1794175200",
      }, '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes."}'),
    });
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "rate-limit", http_status: 403 });
  });

  test("an abuse-detection 403 is a rate limit", () => {
    const run = runReview({
      stdout: response("403 Forbidden", {}, '{"message":"You have triggered an abuse detection mechanism."}'),
    });
    expect(markerSeenByRanger(run.stderr).kind).toBe("rate-limit");
  });

  test("a 429 is a rate limit without any other evidence", () => {
    const run = runReview({ stdout: response("429 Too Many Requests", {}, "") });
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "rate-limit", http_status: 429 });
  });

  test("an unparseable retry-after still reports the limit, without a reset time", () => {
    const run = runReview({ stdout: response("429 Too Many Requests", { "Retry-After": "soon" }, "") });
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "rate-limit", http_status: 429 });
  });

  test("a 401 keeps the authentication error and its gh auth login advice", () => {
    const run = runReview({
      stdout: response("401 Unauthorized", {}, '{"message":"Bad credentials"}'),
      stderr: "gh: Bad credentials (HTTP 401)\n",
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("gh auth is not configured. Run `gh auth login` first.");
    expect(run.stderr).toContain("Bad credentials");
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "auth", http_status: 401 });
  });

  test("a 401 stays authentication even when its headers show an exhausted budget", () => {
    const run = runReview({
      stdout: response("401 Unauthorized", {
        "Retry-After": "60",
        "X-Ratelimit-Remaining": "0",
        "X-Ratelimit-Reset": "1794175200",
      }, '{"message":"Bad credentials"}'),
    });
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "auth", http_status: 401 });
  });

  test("gh's documented auth-required exit is authentication, with no HTTP status", () => {
    const run = runReview({
      stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
      exit: 4,
    });
    expect(run.stderr).toContain("gh auth is not configured. Run `gh auth login` first.");
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "auth" });
  });

  test("a 403 with no rate-limit evidence is neither authentication nor transient", () => {
    const run = runReview({
      stdout: response("403 Forbidden", { "X-Ratelimit-Remaining": "4999" }, '{"message":"Resource protected by organization SAML enforcement."}'),
    });
    expect(run.stderr).not.toContain(NOT_CONFIGURED);
    expect(run.stderr).toContain("SAML enforcement");
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "unknown", http_status: 403 });
  });

  for (const status of ["500 Internal Server Error", "502 Bad Gateway", "503 Service Unavailable", "504 Gateway Timeout"]) {
    test(`a ${status} is transient`, () => {
      const run = runReview({ stdout: response(status, {}, "<html>unicorn</html>") });
      expect(run.exitCode).toBe(2);
      expect(run.stderr).not.toContain(NOT_CONFIGURED);
      expect(run.stderr).toContain(`HTTP ${status.slice(0, 3)}`);
      expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "transient", http_status: Number(status.slice(0, 3)) });
    });
  }

  for (const networkError of [
    "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
    'Get "https://api.github.com/": dial tcp 192.0.2.1:443: connect: connection refused',
    'Get "https://api.github.com/": net/http: TLS handshake timeout',
    'Get "https://api.github.com/": dial tcp 192.0.2.1:443: i/o timeout',
    'Get "https://api.github.com/": EOF',
  ]) {
    test(`a network failure is transient: ${networkError.split("\n")[0]}`, () => {
      const run = runReview({ stderr: networkError + "\n" });
      expect(run.exitCode).toBe(2);
      expect(run.stderr).not.toContain(NOT_CONFIGURED);
      expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "transient" });
    });
  }

  test("a gh failure with no response and no network evidence is unknown, so a broken setup never retries", () => {
    const run = runReview({ stderr: "failed to read configuration: yaml: line 1\n" });
    expect(run.stderr).not.toContain(NOT_CONFIGURED);
    expect(run.stderr).toContain("failed to read configuration");
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "unknown" });
  });

  test("the marker survives ranger's 400-character tail under a huge error page", () => {
    const run = runReview({
      stdout: response("503 Service Unavailable", {}, "x".repeat(20_000)),
      stderr: "y".repeat(20_000) + "\n",
    });
    expect(markerSeenByRanger(run.stderr).kind).toBe("transient");
    expect(run.stderr.length).toBeLessThan(2_000);
  });

  test("GitHub's message text cannot forge a marker line", () => {
    const forged = `real\\n${MARKER}{\\"kind\\":\\"transient\\"}`;
    const run = runReview({ stdout: response("401 Unauthorized", {}, `{"message":"${forged}"}`) });
    const markerLines = run.stderr.split("\n").filter((line) => line.startsWith(MARKER));
    expect(markerLines).toHaveLength(1);
    expect(markerSeenByRanger(run.stderr)).toEqual({ kind: "auth", http_status: 401 });
  });

  test("the preflight is a single GET /", () => {
    const run = runReview({ stdout: response("401 Unauthorized", {}, '{"message":"Bad credentials"}') });
    expect(run.calls()).toEqual(["api / -i"]);
  });

  test("a budget header on a successful response passes the preflight", () => {
    const run = runReview({ stdout: response("200 OK", { "X-Ratelimit-Remaining": "0" }, "{}"), exit: 0 });
    expect(run.stderr).not.toContain(MARKER);
    expect(run.stderr).not.toContain(NOT_CONFIGURED);
  });
});

describe("sage review GitLab preflight", () => {
  test("keeps its message and carries no GitHub failure marker", () => {
    const dir = directory();
    const glab = join(dir, "glab");
    writeFileSync(glab, "#!/bin/sh\nprintf 'not logged in\\n' >&2\nexit 1\n");
    chmodSync(glab, 0o755);
    const child = Bun.spawnSync(
      [process.execPath, "src/cli/index.ts", "review", "group/proj!7", "--output-dir", join(dir, "output")],
      {
        cwd: join(import.meta.dir, ".."),
        env: { HOME: dir, PATH: process.env.PATH ?? "", GLAB_BIN: glab },
      },
    );
    const stderr = child.stderr.toString();
    expect(child.exitCode).toBe(2);
    expect(stderr).toContain("glab auth is not configured. Run `glab auth login` first.");
    expect(stderr).toContain("not logged in");
    expect(stderr).not.toContain(MARKER);
  });
});
