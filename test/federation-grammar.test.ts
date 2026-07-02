/**
 * FederationGrammar lens — ports compass sops/federation-wire-protocol.md
 * checks 1-5 (compass#99 F8). Applicability (fires on wire-touching diffs,
 * silent otherwise) is covered by applicability.test.ts; this file covers
 * the lens's own plumbing: it requests architecture docs, passes findings
 * through unmodified, and a fail-closed violation on originator (check 4)
 * comes back as a blocker so the verdict gate can't approve it.
 */

import { describe, test, expect } from "bun:test";
import { reviewFederationGrammar } from "../src/lenses/federation-grammar.ts";
import { TEXT_EXTRACTORS } from "../src/substrate/json/index.ts";
import type { Substrate } from "../src/substrate/types.ts";
import type { ArchitectureDocsContext } from "../src/lenses/architecture-docs.ts";

function substrateReturning(
  json: unknown,
  onRun?: (opts: { systemPrompt?: string; prompt: string; stdin?: string }) => void,
): Substrate {
  return {
    name: "pi",
    displayName: "pi.dev",
    bin: "pi",
    jsonExtractors: TEXT_EXTRACTORS,
    envRequirements: { namespaces: [], keys: [] },
    run: async (opts) => {
      onRun?.(opts);
      return { stdout: JSON.stringify(json), stderr: "", exitCode: 0, durationMs: 1 };
    },
  };
}

const pr = {
  number: 1,
  title: "route verdicts back to the requester",
  body: "",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feat/verdict-routing",
  headRefOid: "abc123def456",
  author: { login: "a" },
  changedFiles: 1,
  additions: 5,
  deletions: 0,
  files: [{ path: "src/bus/review-consumer.ts", additions: 5, deletions: 0 }],
  url: "https://github.com/the-metafactory/cortex/pull/1",
};

const diff = `diff --git a/src/bus/review-consumer.ts b/src/bus/review-consumer.ts
+const requester = envelope.originator?.identity ?? envelope.source;
+publishVerdict(requester, verdict);
`;

const architectureDocs: ArchitectureDocsContext = {
  hasLoadedDocs: true,
  provenance: "architecture-docs: CONTEXT.md (loaded)",
  docs: [
    {
      path: "CONTEXT.md",
      status: "loaded",
      content: "## Network\noriginator.identity is the canonical requester DID.",
      truncated: false,
    },
  ],
};

describe("reviewFederationGrammar", () => {
  test("opts into architecture docs (CONTEXT.md §Network grounding)", async () => {
    let capturedStdin: string | undefined;
    let capturedSystemPrompt: string | undefined;
    const substrate = substrateReturning(
      { summary: "checked", findings: [] },
      (opts) => {
        capturedStdin = opts.stdin;
        capturedSystemPrompt = opts.systemPrompt;
      },
    );

    await reviewFederationGrammar({ pr, diff, substrate, architectureDocs });

    expect(capturedStdin).toContain("Architecture context docs:");
    expect(capturedStdin).toContain("originator.identity is the canonical requester DID");
    expect(capturedSystemPrompt).toContain("running the FederationGrammar lens");
    expect(capturedSystemPrompt).toContain("FAIL CLOSED");
  });

  test("fail-closed check 4 violation (malformed/absent originator) comes back as a blocker", async () => {
    const substrate = substrateReturning({
      summary: "Verdict routing falls back to source instead of failing closed on a missing originator.",
      findings: [
        {
          path: "src/bus/review-consumer.ts",
          line: 1,
          severity: "blocker",
          title: "Verdict-back does not fail closed on malformed originator",
          rationale:
            'The diff `envelope.originator?.identity ?? envelope.source` falls back to `source` ' +
            "(which addresses the target, not the requester) instead of dropping the envelope " +
            "when originator is absent or malformed — violates check 4.",
        },
      ],
    });

    const report = await reviewFederationGrammar({ pr, diff, substrate });

    expect(report.lens).toBe("FederationGrammar");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.severity).toBe("blocker");
    expect(report.findings[0]!.title).toContain("fail closed");
  });

  test("passes through a clean (no-violation) report unchanged", async () => {
    const substrate = substrateReturning({
      summary: "Wire-protocol checks 1-5 all satisfied.",
      findings: [],
    });

    const report = await reviewFederationGrammar({ pr, diff, substrate });

    expect(report.lens).toBe("FederationGrammar");
    expect(report.findings).toHaveLength(0);
  });
});
