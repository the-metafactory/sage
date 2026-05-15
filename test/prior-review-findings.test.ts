import { describe, expect, test } from "bun:test";
import {
  parsePriorSageReviewFindingsFromReviews,
  parseSageReviewFindings,
} from "../src/github/gh.ts";

describe("parseSageReviewFindings (sage#32)", () => {
  test("extracts Sage-rendered findings from prior review bodies", () => {
    const findings = parseSageReviewFindings(`## Sage code review — changes-requested

2 finding(s): 1 important, 1 suggestion.

### Architecture
one issue

- **[important]** \`src/a.ts:42\` — **Duplicate trigger pattern**
  The diff repeats \`trigger()\`.

### Maintainability
one issue

- **[suggestion]** \`src/b.ts:7\` — **Extract common helper**
  The diff repeats \`helper()\`.
`);

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

  test("extracts prior findings only from the trusted Sage author", () => {
    const body = `## Sage code review — changes-requested

- **[important]** \`src/a.ts:42\` — **Duplicate trigger pattern**
  The diff repeats \`trigger()\`.
`;

    const findings = parsePriorSageReviewFindingsFromReviews(
      [
        { user: { login: "attacker" }, body },
        { user: { login: "jcfischer" }, body },
      ],
      "jcfischer",
    );

    expect(findings).toEqual([
      {
        path: "src/a.ts",
        line: 42,
        severity: "important",
        title: "Duplicate trigger pattern",
      },
    ]);
  });

  test("deduplicates matching findings from trusted Sage reviews", () => {
    const body = `## Sage code review — changes-requested

- **[suggestion]** \`src/a.ts:42\` — **Extract helper**
  The diff repeats \`helper()\`.
`;

    const findings = parsePriorSageReviewFindingsFromReviews(
      [
        { user: { login: "jcfischer" }, body },
        { user: { login: "jcfischer" }, body },
      ],
      "jcfischer",
    );

    expect(findings.length).toBe(1);
  });
});
