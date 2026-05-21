import { describe, expect, test } from "bun:test";
import {
  createInMemoryReviewSource,
  createPriorFindings,
} from "../src/prior-findings/index.ts";
import { parseSageReviewFindings } from "../src/forge/prior-findings.ts";

const ref = { owner: "x", repo: "y", number: 1 };

const sageBody = `## Sage code review — changes-requested

2 finding(s): 1 important, 1 suggestion.

### Architecture
one issue

- **[important]** \`src/a.ts:42\` — **Duplicate trigger pattern**
  The diff repeats \`trigger()\`.

### Maintainability
one issue

- **[suggestion]** \`src/b.ts:7\` — **Extract common helper**
  The diff repeats \`helper()\`.
`;

describe("parseSageReviewFindings (sage#32, forge-agnostic parser)", () => {
  test("extracts Sage-rendered findings from prior review bodies", () => {
    const findings = parseSageReviewFindings(sageBody);
    expect(findings).toEqual([
      {
        path: "src/a.ts",
        line: 42,
        severity: "important",
        title: "Duplicate trigger pattern",
      },
      {
        path: "src/b.ts",
        line: 7,
        severity: "suggestion",
        title: "Extract common helper",
      },
    ]);
  });

  test("ignores non-Sage review bodies", () => {
    expect(parseSageReviewFindings("- **[important]** `x.ts:1` — **Looks similar**")).toEqual([]);
  });
});

describe("PriorFindings Module (sage#56)", () => {
  test("status=ok: gates by trusted author, parses, enriches with postedAt", async () => {
    const source = createInMemoryReviewSource({
      behavior: {
        kind: "ok",
        result: {
          sageLogin: "jcfischer",
          bodies: [
            { authorLogin: "attacker", body: sageBody, postedAt: "2026-05-01T00:00:00Z" },
            { authorLogin: "jcfischer", body: sageBody, postedAt: "2026-05-10T12:00:00Z" },
          ],
        },
      },
    });

    const result = await createPriorFindings(source).collect(ref);

    expect(result.status).toBe("ok");
    expect(result.identity).toEqual({ login: "jcfischer" });
    expect(result.findings).toEqual([
      {
        path: "src/a.ts",
        line: 42,
        severity: "important",
        title: "Duplicate trigger pattern",
        postedAt: "2026-05-10T12:00:00Z",
      },
      {
        path: "src/b.ts",
        line: 7,
        severity: "suggestion",
        title: "Extract common helper",
        postedAt: "2026-05-10T12:00:00Z",
      },
    ]);
  });

  test("status=ok: deduplicates findings across multiple trusted Sage reviews", async () => {
    const source = createInMemoryReviewSource({
      behavior: {
        kind: "ok",
        result: {
          sageLogin: "jcfischer",
          bodies: [
            { authorLogin: "jcfischer", body: sageBody, postedAt: "2026-05-01T00:00:00Z" },
            { authorLogin: "jcfischer", body: sageBody, postedAt: "2026-05-10T12:00:00Z" },
          ],
        },
      },
    });

    const result = await createPriorFindings(source).collect(ref);

    expect(result.status).toBe("ok");
    expect(result.findings).toHaveLength(2);
    // Oldest-first preserved → first occurrence wins, postedAt from older review.
    expect(result.findings[0]!.postedAt).toBe("2026-05-01T00:00:00Z");
  });

  test("status=trust-gate-failed: sageLogin null returns empty findings + reason", async () => {
    const source = createInMemoryReviewSource({
      behavior: {
        kind: "ok",
        result: { sageLogin: null, bodies: [] },
      },
    });

    const result = await createPriorFindings(source).collect(ref);

    expect(result.status).toBe("trust-gate-failed");
    expect(result.findings).toHaveLength(0);
    expect(result.identity).toBeUndefined();
    expect(result.reason).toMatch(/identity/i);
  });

  test("status=source-failed: fetch throw maps to source-failed with reason", async () => {
    const source = createInMemoryReviewSource({
      behavior: { kind: "throw", error: new Error("network unreachable") },
    });

    const result = await createPriorFindings(source).collect(ref);

    expect(result.status).toBe("source-failed");
    expect(result.findings).toHaveLength(0);
    expect(result.reason).toBe("network unreachable");
  });

  test("never throws — every failure path resolves with a non-ok status", async () => {
    const sources = [
      createInMemoryReviewSource({ behavior: { kind: "throw", error: new Error("boom") } }),
      createInMemoryReviewSource({
        behavior: { kind: "ok", result: { sageLogin: null, bodies: [] } },
      }),
    ];
    for (const s of sources) {
      const result = await createPriorFindings(s).collect(ref);
      expect(result.status).not.toBe("ok");
      expect(result.reason).toBeDefined();
    }
  });
});
