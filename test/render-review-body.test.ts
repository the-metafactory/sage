import { describe, expect, test } from "bun:test";
import { renderReviewBody } from "../src/lenses/workflow.ts";
import type { ReviewVerdict, LensReport } from "../src/lenses/types.ts";

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

describe("renderReviewBody errored-lens visual marker (sage#27 round 2)", () => {
  test("clean lens renders with plain heading", () => {
    const verdict: ReviewVerdict = {
      decision: "approved",
      summary: "No findings. Sage approves.",
      lenses: [cleanLens("CodeQuality")],
    };
    const body = renderReviewBody(verdict, "pi.dev");
    expect(body).toMatch(/### CodeQuality\n/);
    expect(body).not.toMatch(/DID NOT RUN/);
    expect(body).not.toMatch(/Lens failed to execute/);
  });

  test("errored lens heading carries 'DID NOT RUN' marker", () => {
    const verdict: ReviewVerdict = {
      decision: "changes-requested",
      summary: "1 lens(es) failed to run: Security.",
      lenses: [erroredLens("Security", "pi unreachable")],
    };
    const body = renderReviewBody(verdict, "pi.dev");
    expect(body).toMatch(/### Security — DID NOT RUN/);
  });

  test("errored lens renders a callout above the findings", () => {
    const verdict: ReviewVerdict = {
      decision: "changes-requested",
      summary: "1 lens(es) failed to run: Security.",
      lenses: [erroredLens("Security", "pi unreachable")],
    };
    const body = renderReviewBody(verdict, "pi.dev");
    expect(body).toMatch(
      /> ⚠ Lens failed to execute\. Verdict cannot rely on this lens's coverage/,
    );
  });

  test("mixed verdict — errored section marked, clean sections plain", () => {
    const verdict: ReviewVerdict = {
      decision: "changes-requested",
      summary: "1 lens(es) failed to run: Performance.",
      lenses: [
        cleanLens("CodeQuality"),
        erroredLens("Performance", "timeout"),
        cleanLens("Maintainability"),
      ],
    };
    const body = renderReviewBody(verdict, "pi.dev");
    expect(body).toMatch(/### CodeQuality\n/);
    expect(body).toMatch(/### Performance — DID NOT RUN/);
    expect(body).toMatch(/### Maintainability\n/);
    // Single callout — only the errored section has it.
    const callouts = body.match(/Lens failed to execute/g) ?? [];
    expect(callouts.length).toBe(1);
  });
});
