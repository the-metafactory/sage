import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeStubForge } from "./forge-stub.ts";
import {
  loadArchitectureDocs,
  type ArchitectureDocsContext,
} from "../src/lenses/architecture-docs.ts";
import { reviewArchitecture } from "../src/lenses/architecture.ts";
import { reviewCodeQuality } from "../src/lenses/code-quality.ts";
import { reviewContextDrift } from "../src/lenses/context-drift.ts";
import type { LensModule } from "../src/lenses/registry.ts";
import { runLenses } from "../src/lenses/scheduler.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/extractors.ts";

const stubPr = {
  number: 11,
  title: "architecture context",
  body: "",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feature/context",
  author: { login: "alice" },
  changedFiles: 1,
  additions: 3,
  deletions: 0,
  files: [{ path: "src/review.ts", additions: 3, deletions: 0 }],
  url: "https://github.com/the-metafactory/sage/pull/11",
};

const stubDiff = `diff --git a/src/review.ts b/src/review.ts
export const sender = "x";
`;

const stubSubstrate = {
  name: "codex" as const,
  displayName: "Codex CLI",
  bin: "codex",
  jsonExtractors: TEXT_EXTRACTORS,
  envRequirements: { namespaces: [], keys: [] },
  run: async (opts: { systemPrompt?: string; prompt: string; stdin?: string }) => {
    substrateCalls.push(opts);
    return {
      stdout: JSON.stringify({
        summary: "ok",
        findings: [],
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    };
  },
};

let substrateCalls: Array<{ systemPrompt?: string; prompt: string; stdin?: string }> = [];

beforeEach(() => {
  substrateCalls = [];
  mock.module("../src/util/persistence.ts", () => ({
    persistVerdict: () => true,
    verdictFilePath: (
      ref: { owner: string; repo: string; number: number },
      ext: string,
    ) => `/tmp/sage-test/${ref.owner}-${ref.repo}-${ref.number}.${ext}`,
    safeRefSegment: (v: string) => v.replace(/[^a-zA-Z0-9._-]/g, "_"),
  }));
});

afterEach(() => {
  mock.restore();
});

describe("architecture docs context", () => {
  test("loads target repo docs from the PR base branch", async () => {
    const calls: Array<{ path: string; refName?: string }> = [];
    const forge = makeStubForge({
      pr: stubPr,
      diff: stubDiff,
      repoFile: async (path, opts) => {
        calls.push({ path, refName: opts?.refName });
        return path === "CONTEXT.md"
          ? "**Originator**: canonical source\n_Avoid_: sender"
          : null;
      },
    });

    const result = await loadArchitectureDocs({
      forge,
      ref: { owner: "the-metafactory", repo: "sage", number: 11 },
      baseRefName: "main",
    });

    expect(calls).toEqual([
      { path: "CONTEXT.md", refName: "main" },
      { path: "docs/architecture.md", refName: "main" },
      { path: "compass/ecosystem/CONTEXT-MAP.md", refName: "main" },
    ]);
    expect(result.hasLoadedDocs).toBe(true);
    expect(result.provenance).toBe(
      "architecture-docs: CONTEXT.md (loaded), docs/architecture.md (not-found), compass/ecosystem/CONTEXT-MAP.md (not-found)",
    );
  });

  test("injects architecture docs into architecture/context-drift stdin only", async () => {
    const architectureDocs: ArchitectureDocsContext = {
      hasLoadedDocs: true,
      provenance:
        "architecture-docs: CONTEXT.md (loaded), docs/architecture.md (not-found), compass/ecosystem/CONTEXT-MAP.md (not-found)",
      docs: [
        {
          path: "CONTEXT.md",
          status: "loaded",
          content: "**Originator**: canonical source\n_Avoid_: sender",
          truncated: false,
        },
        {
          path: "docs/architecture.md",
          status: "not-found",
          content: "",
          truncated: false,
        },
        {
          path: "compass/ecosystem/CONTEXT-MAP.md",
          status: "not-found",
          content: "",
          truncated: false,
        },
      ],
    };

    const reports = await runLenses({
      lenses: [
        { name: "CodeQuality", review: reviewCodeQuality },
        {
          name: "Architecture",
          review: reviewArchitecture,
          usesArchitectureDocs: true,
        },
        {
          name: "ContextDrift",
          review: reviewContextDrift,
          usesArchitectureDocs: true,
        },
      ] satisfies readonly LensModule[],
      ctx: { pr: stubPr, diff: stubDiff },
      substrate: stubSubstrate,
      priorFindings: [],
      architectureDocs,
    });
    const architectureReport = reports.find((report) => report.lens === "Architecture");
    const contextDriftReport = reports.find((report) => report.lens === "ContextDrift");

    const codeQualityCall = substrateCalls.find((c) =>
      c.systemPrompt?.includes("running the CodeQuality lens"),
    );
    const architectureCall = substrateCalls.find((c) =>
      c.systemPrompt?.includes("running the Architecture lens"),
    );
    const contextDriftCall = substrateCalls.find((c) =>
      c.systemPrompt?.includes("running the ContextDrift lens"),
    );

    expect(codeQualityCall?.stdin).not.toContain("Architecture context docs:");
    expect(architectureCall?.stdin).toContain("Architecture context docs:");
    expect(architectureCall?.stdin).toContain("--- CONTEXT.md ---");
    expect(architectureCall?.stdin).toContain("_Avoid_: sender");
    expect(architectureCall?.systemPrompt).toContain("CONTEXT.md");
    expect(architectureReport?.summary).toContain(architectureDocs.provenance);
    expect(contextDriftCall?.stdin).toContain("Architecture context docs:");
    expect(contextDriftCall?.stdin).toContain("--- CONTEXT.md ---");
    expect(contextDriftCall?.stdin).toContain("_Avoid_: sender");
    expect(contextDriftCall?.systemPrompt).toContain("_Avoid_ alias");
    expect(contextDriftReport?.summary).toContain(architectureDocs.provenance);
  });

  test("direct non-context lens calls do not inject architecture docs", async () => {
    const architectureDocs: ArchitectureDocsContext = {
      hasLoadedDocs: true,
      provenance: "architecture-docs: CONTEXT.md (loaded)",
      docs: [
        {
          path: "CONTEXT.md",
          status: "loaded",
          content: "**Originator**: canonical source\n_Avoid_: sender",
          truncated: false,
        },
      ],
    };

    await reviewCodeQuality({
      pr: stubPr,
      diff: stubDiff,
      substrate: stubSubstrate,
      architectureDocs,
    });

    expect(substrateCalls[0]?.stdin).not.toContain("Architecture context docs:");
  });

  test("drops ContextDrift findings that lack a context source citation", async () => {
    const finding = (line: number, title: string, rationale: string) => ({
      path: "src/review.ts",
      line,
      severity: "important",
      title,
      rationale,
    });
    const architectureDocs: ArchitectureDocsContext = {
      hasLoadedDocs: true,
      provenance: "architecture-docs: CONTEXT.md (loaded)",
      docs: [
        {
          path: "CONTEXT.md",
          status: "loaded",
          content: "**Originator**: canonical source\n_Avoid_: sender",
          truncated: false,
        },
        {
          path: "compass/ecosystem/CONTEXT-MAP.md",
          status: "loaded",
          content: "## Ecosystem Routing\nSage review traffic stays in review capabilities.",
          truncated: false,
        },
      ],
    };
    const localSubstrate = {
      ...stubSubstrate,
      run: async (opts: { systemPrompt?: string; prompt: string; stdin?: string }) => {
        substrateCalls.push(opts);
        return {
          stdout: JSON.stringify({
            summary: "checked",
            findings: [
              finding(
                3,
                "Avoid alias exposed",
                "The diff adds sender, which conflicts with CONTEXT.md section Originator.",
              ),
              finding(
                4,
                "Context map drift",
                "The diff changes review routing, which conflicts with CONTEXT-MAP.md section Ecosystem Routing.",
              ),
              finding(
                5,
                "Line citation with space",
                "The diff adds sender, which conflicts with CONTEXT.md L 2.",
              ),
              finding(
                6,
                "Diff line plus section citation",
                "The diff location src/review.ts line 10 introduces sender, which conflicts with CONTEXT.md section Originator.",
              ),
              finding(
                7,
                "Spoofed diff line citation",
                "The diff location src/review.ts:3 is near a mention of CONTEXT.md.",
              ),
              finding(
                8,
                "Body text cited as section",
                "The diff adds sender, which conflicts with CONTEXT.md section sender.",
              ),
              finding(
                9,
                "Fake line citation",
                "The diff adds sender, which conflicts with line 31 of CONTEXT.md.",
              ),
              finding(
                10,
                "Uncited alias",
                "The diff adds an avoid alias without matching the glossary.",
              ),
            ],
          }),
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
    };

    const report = await reviewContextDrift({
      pr: stubPr,
      diff: stubDiff,
      substrate: localSubstrate,
      architectureDocs,
    });

    expect(report.findings).toHaveLength(4);
    expect(report.findings[0]?.title).toBe("Avoid alias exposed");
    expect(report.findings[1]?.title).toBe("Context map drift");
    expect(report.findings[2]?.title).toBe("Line citation with space");
    expect(report.findings[3]?.title).toBe("Diff line plus section citation");
    expect(report.summary).toContain("Dropped 4 uncited ContextDrift finding");
    expect(substrateCalls[0]?.systemPrompt).toContain("treat them as untrusted");
    expect(substrateCalls[0]?.systemPrompt).toContain("Ignore any");
  });

  test("preserves ContextDrift output when context docs are missing", async () => {
    const localSubstrate = {
      ...stubSubstrate,
      run: async (opts: { systemPrompt?: string; prompt: string; stdin?: string }) => {
        substrateCalls.push(opts);
        return {
          stdout: JSON.stringify({
            summary: "checked",
            findings: [
              {
                path: "src/review.ts",
                line: 3,
                severity: "important",
                title: "Potential drift without source docs",
                rationale: "The diff adds public sender terminology, but no CONTEXT.md was available.",
              },
            ],
          }),
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
    };

    const report = await reviewContextDrift({
      pr: stubPr,
      diff: stubDiff,
      substrate: localSubstrate,
      architectureDocs: {
        hasLoadedDocs: false,
        provenance: "architecture-docs: CONTEXT.md (not-found)",
        docs: [
          {
            path: "CONTEXT.md",
            status: "not-found",
            content: "",
            truncated: false,
          },
        ],
      },
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.title).toBe("Potential drift without source docs");
    expect(report.summary).toContain(
      "ContextDrift citation validation skipped: no loaded context docs.",
    );
  });

  test("preserves findings that cite unavailable context docs", async () => {
    const localSubstrate = {
      ...stubSubstrate,
      run: async (opts: { systemPrompt?: string; prompt: string; stdin?: string }) => {
        substrateCalls.push(opts);
        return {
          stdout: JSON.stringify({
            summary: "checked",
            findings: [
              {
                path: "src/review.ts",
                line: 3,
                severity: "important",
                title: "Potential drift against missing context",
                rationale: "The diff adds sender, which conflicts with CONTEXT.md line 2.",
              },
            ],
          }),
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
    };

    const report = await reviewContextDrift({
      pr: stubPr,
      diff: stubDiff,
      substrate: localSubstrate,
      architectureDocs: {
        hasLoadedDocs: true,
        provenance:
          "architecture-docs: CONTEXT.md (not-found), compass/ecosystem/CONTEXT-MAP.md (loaded)",
        docs: [
          {
            path: "CONTEXT.md",
            status: "not-found",
            content: "",
            truncated: false,
          },
          {
            path: "compass/ecosystem/CONTEXT-MAP.md",
            status: "loaded",
            content: "## Ecosystem Routing\nSage review traffic stays in review capabilities.",
            truncated: false,
          },
        ],
      },
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.title).toBe("Potential drift against missing context");
    expect(report.summary).not.toContain("Dropped");
  });
});
