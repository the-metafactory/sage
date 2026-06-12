import { describe, expect, test } from "bun:test";
import { parseSageReviewFindings } from "../src/forge/github/backend.ts";
import type { LensReport } from "../src/lenses/types.ts";
import { renderVerdict, type Verdict } from "../src/verdict/index.ts";

/**
 * sage#27 Holly re-review (finding #5): a lens that errored is visually
 * distinct in the rendered review body. Operators reading the GH
 * review should not need to pattern-match on `(lens runtime)` or
 * `(lens output)` in the finding path to notice a lens didn't run.
 */

function cleanLens(name: string): LensReport {
  return { lens: name, summary: "ok", findings: [], durationMs: 1 };
}

function erroredLens(name: string, msg: string): LensReport {
  return {
    lens: name,
    summary: `Lens "${name}" failed to execute; verdict cannot rely on this lens.`,
    findings: [
      {
        path: "(lens runtime)",
        line: 0,
        severity: "important",
        title: `${name}: lens runtime error`,
        rationale: msg,
      },
    ],
    durationMs: 0,
    errored: true,
  };
}

describe("renderVerdict compact review body", () => {
  test("clean lenses are omitted from the rendered body", () => {
    const verdict: Verdict = {
      decision: "approved",
      summary: "No findings. Sage approves.",
      lenses: [cleanLens("CodeQuality")],
    };
    const body = renderVerdict(verdict, "pi.dev");
    expect(body).not.toMatch(/### CodeQuality\n/);
    expect(body).not.toMatch(/_No findings\._/);
    expect(body).not.toMatch(/DID NOT RUN/);
    expect(body).not.toMatch(/Lens failed to execute/);
  });

  test("errored lens heading carries 'DID NOT RUN' marker", () => {
    const verdict: Verdict = {
      decision: "changes-requested",
      summary: "1 lens(es) failed to run: Security.",
      lenses: [erroredLens("Security", "pi unreachable")],
    };
    const body = renderVerdict(verdict, "pi.dev");
    expect(body).toMatch(/### Security — DID NOT RUN/);
  });

  test("errored lens renders a compact coverage warning", () => {
    const verdict: Verdict = {
      decision: "changes-requested",
      summary: "1 lens(es) failed to run: Security.",
      lenses: [erroredLens("Security", "pi unreachable")],
    };
    const body = renderVerdict(verdict, "pi.dev");
    expect(body).toMatch(/Coverage incomplete; re-run before merge\./);
    expect(body).not.toMatch(/Lens failed to execute\. Verdict cannot rely/);
    expect(body).toMatch(/pi unreachable/);
  });

  test("errored section does NOT render lens.summary line", () => {
    // Holly round 3 finding #3: pre-fix the operator saw the failure
    // stated three times — heading, callout, AND lens.summary. The
    // renderer now drops the lens.summary line on errored sections.
    // The summary content (`Lens "X" did not produce a usable
    // verdict; verdict cannot rely on this lens.`) must not appear in
    // the rendered body even though it's on the LensReport object.
    const verdict: Verdict = {
      decision: "changes-requested",
      summary: "1 lens(es) failed to run: Security.",
      lenses: [erroredLens("Security", "pi unreachable")],
    };
    const body = renderVerdict(verdict, "pi.dev");
    expect(body).not.toMatch(
      /Lens "Security" failed to execute; verdict cannot rely on this lens\.|did not produce a usable verdict/,
    );
    expect(body).toMatch(/### Security — DID NOT RUN/);
  });

  test("mixed verdict renders only non-clean sections", () => {
    const verdict: Verdict = {
      decision: "changes-requested",
      summary: "1 lens(es) failed to run: Performance.",
      lenses: [
        cleanLens("CodeQuality"),
        erroredLens("Performance", "timeout"),
        cleanLens("Maintainability"),
      ],
    };
    const body = renderVerdict(verdict, "pi.dev");
    expect(body).not.toMatch(/### CodeQuality\n/);
    expect(body).toMatch(/### Performance — DID NOT RUN/);
    expect(body).not.toMatch(/### Maintainability\n/);
  });

  test("deduped cross-lens finding renders contributing lenses", () => {
    const verdict: Verdict = {
      decision: "changes-requested",
      summary: "1 finding(s): 1 important.",
      lenses: [
        {
          lens: "Architecture",
          summary: "one issue",
          findings: [
            {
              path: "src/a.ts",
              line: 42,
              severity: "important",
              title: "Duplicate trigger pattern",
              rationale: "The diff repeats `trigger()`.",
              sourceLenses: ["Architecture", "Maintainability"],
            },
          ],
          durationMs: 1,
        },
        cleanLens("Maintainability"),
      ],
    };

    const body = renderVerdict(verdict, "codex");
    expect(body).toMatch(/via: Architecture, Maintainability/);
    expect(body).not.toMatch(/### Maintainability\n/);
  });

  test("rendered finding headings round-trip through prior-review parser", () => {
    const verdict: Verdict = {
      decision: "changes-requested",
      summary: "1 finding(s): 1 important.",
      lenses: [
        {
          lens: "Security",
          summary: "one issue",
          findings: [
            {
              path: "src/forge/github/backend.ts",
              line: 292,
              severity: "important",
              title: "Prior findings can be spoofed",
              rationale: "The diff trusts `body` without checking `user.login`.",
            },
          ],
          durationMs: 1,
        },
      ],
    };

    const body = renderVerdict(verdict, "codex");
    expect(parseSageReviewFindings(body)).toEqual([
      {
        path: "src/forge/github/backend.ts",
        line: 292,
        severity: "important",
        title: "Prior findings can be spoofed",
      },
    ]);
  });

  test("single-line suggestions render inline", () => {
    const verdict: Verdict = {
      decision: "commented",
      summary: "1 finding(s): 1 suggestion.",
      lenses: [
        {
          lens: "Maintainability",
          summary: "one issue",
          findings: [
            {
              path: "src/a.ts",
              line: 10,
              severity: "suggestion",
              title: "Extract helper",
              rationale: "The diff repeats `parseRef()`.",
              suggestion: "Move the shared parsing into `parseRef()`.",
            },
          ],
          durationMs: 1,
        },
      ],
    };

    const body = renderVerdict(verdict, "codex");
    expect(body).toMatch(/Fix: Move the shared parsing into `parseRef\(\)`\./);
    expect(body).not.toMatch(/Suggestion:/);
  });
});
