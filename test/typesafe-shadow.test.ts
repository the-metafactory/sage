import { describe, expect, test } from "bun:test";

import type { CorpusManifest } from "../src/typesafe/corpus.ts";
import { createTypeSafeShadowObserver } from "../src/typesafe/shadow.ts";
import { buildBoundedReviewState, redactTypeSafeText } from "../src/typesafe/state.ts";
import { TYPESAFE_POLICY, TYPESAFE_POLICY_HASH } from "../src/typesafe/policy.ts";
import type {
  ChoiceQuestion,
  ShadowComparisonRecord,
  ShadowReviewInput,
  SystemOneRequest,
  TypeSafeTransport,
} from "../src/typesafe/types.ts";
import adversarial from "./fixtures/typesafe/adversarial.json";

const HEAD = "a".repeat(40);

const input: ShadowReviewInput = {
  ref: { owner: "the-metafactory", repo: "seelite", number: 42 },
  pr: {
    number: 42,
    title: "Improve ship combat",
    body: "",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/combat",
    headRefOid: HEAD,
    author: { login: "pilot" },
    changedFiles: 2,
    additions: 24,
    deletions: 3,
    files: [
      { path: "src/game.ts", additions: 20, deletions: 3 },
      { path: "test/game.test.ts", additions: 4, deletions: 0 },
    ],
    url: "https://github.com/the-metafactory/seelite/pull/42",
  },
  diff: `diff --git a/src/game.ts b/src/game.ts
@@ -1,2 +1,5 @@
+const apiKey = super-secret-value
+export function fight() { return true; }
diff --git a/test/game.test.ts b/test/game.test.ts
@@ -1,1 +1,2 @@
+test("fight", () => expect(fight()).toBe(true));`,
  baselineLensNames: ["CodeQuality", "Architecture", "Maintainability"],
  lensReports: [
    {
      lens: "Architecture",
      summary: "one finding",
      durationMs: 1,
      findings: [
        {
          path: "src/game.ts",
          line: 2,
          severity: "important",
          title: "Public behavior changed",
          rationale: "The exported behavior changed without a compatibility test.",
        },
      ],
    },
  ],
  verdict: {
    decision: "changes-requested",
    summary: "1 important finding",
    lenses: [],
  },
  posted: false,
};

function manifest(status: "approved" | "pending" = "approved"): CorpusManifest {
  if (status === "pending") {
    return {
      schemaVersion: 1,
      frozenAt: null,
      dataProcessingApproval: { status: "pending" },
      entries: [],
    };
  }
  return {
    schemaVersion: 1,
    frozenAt: "2026-09-18T20:00:00.000Z",
    dataProcessingApproval: {
      status: "approved",
      approvedBy: "principal",
      approvedAt: "2026-09-18T20:00:00.000Z",
      scope: "fixture only",
      termsReviewedAt: "2026-09-18T20:00:00.000Z",
    },
    entries: [
      {
        url: input.pr.url,
        owner: input.ref.owner,
        repo: input.ref.repo,
        number: input.ref.number,
        headSha: HEAD,
        classification: "non-critical-game",
        approvedBy: "principal",
        approvedAt: "2026-09-18T20:00:00.000Z",
      },
    ],
  };
}

function answerFor(id: string, question: ChoiceQuestion, confidence = 0.9) {
  const options = Object.keys(question.criteria);
  const choice = id.endsWith(".candidate")
    ? options.find((option) => option.startsWith("candidate_")) ?? "no_signal"
    : id.startsWith("finding.evidence")
      ? "supported"
      : "recommend";
  const rest = (1 - confidence) / Math.max(1, options.length - 1);
  return {
    type: "choice" as const,
    choice,
    probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? confidence : rest])),
    confidence,
  };
}

function successfulTransport(requests: SystemOneRequest[], confidence = 0.9): TypeSafeTransport {
  return {
    async execute(request) {
      requests.push(request);
      return {
        model: request.model,
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [
            id,
            answerFor(id, question, confidence),
          ]),
        ),
        usage: { input_tokens: 100, output_tokens: 10 },
      };
    },
  };
}

describe("TypeSafe bounded state", () => {
  test("redacts secrets and enforces candidate bounds", () => {
    const state = buildBoundedReviewState(input.pr as never, input.diff, TYPESAFE_POLICY);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).toContain("[REDACTED]");
    expect(state.candidates.length).toBeLessThanOrEqual(TYPESAFE_POLICY.bounds.maxCandidates);
    expect(state.candidates.every((candidate) => candidate.excerpt.length <= 2400)).toBe(true);
  });

  test("redacts bearer tokens, JWTs, and private keys", () => {
    const redacted = redactTypeSafeText(
      "Authorization: Bearer abc.def.ghi token=shh -----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
    );
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("token=shh");
    expect(redacted).not.toContain("\nkey\n");
  });

  test("redacts quoted assignments, YAML blocks, and provider token formats", () => {
    const redacted = redactTypeSafeText([
      `{"api_key": "secret value with spaces"}`,
      "private_key: |\n  line-one\n  line-two",
      "const openai = 'sk-abcdefghijklmnopqrstuv';",
      "const github = 'github_pat_abcdefghijklmnopqrstuvwxyz123456';",
      "const aws = 'AKIAABCDEFGHIJKLMNOP';",
    ].join("\n"));

    expect(redacted).not.toContain("secret value with spaces");
    expect(redacted).not.toContain("line-one");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(redacted).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  test("bounds the entire serialized state including paths and metadata", () => {
    const manyFiles = Array.from({ length: 100 }, (_, index) => ({
      path: `src/${"very-long-segment-".repeat(8)}${index}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const boundedPolicy = {
      ...TYPESAFE_POLICY,
      bounds: { ...TYPESAFE_POLICY.bounds, maxStateChars: 1_200 },
    };
    const state = buildBoundedReviewState({
      ...input.pr,
      title: "large metadata ".repeat(100),
      files: manyFiles,
    } as never, input.diff.repeat(10), boundedPolicy);

    expect(JSON.stringify(state).length).toBeLessThanOrEqual(1_200);
    expect(state.truncation.stateTruncated).toBe(true);
    expect(state.pr.changedPaths.length).toBeLessThan(manyFiles.length);
  });

  test("adversarial content stays bounded data and cannot expand scope", () => {
    const diff = adversarial
      .map((fixture) => `diff --git a/${fixture.path} b/${fixture.path}\n@@ -1 +1 @@\n${fixture.text}`)
      .join("\n");
    const state = buildBoundedReviewState(input.pr as never, diff, TYPESAFE_POLICY);
    expect(state.candidates).toHaveLength(adversarial.length);
    expect(state.pr.changedPaths).toEqual(input.pr.files.map((file) => file.path));
    expect(state.candidates.map((candidate) => candidate.path)).toEqual(
      adversarial.map((fixture) => fixture.path),
    );
  });
});

describe("TypeSafe shadow observer", () => {
  test("records pinned model, hashes, typed signals, usage, evidence, and bounded state", async () => {
    const records: ShadowComparisonRecord[] = [];
    const requests: SystemOneRequest[] = [];
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest(),
      transport: successfulTransport(requests),
      sink: { write: (record) => records.push(record) },
      now: () => new Date("2026-09-18T21:00:00.000Z"),
    });

    await observer.observe(input);

    expect(requests).toHaveLength(2);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.authorizationMode).toBe("frozen-corpus");
    expect(record.modelRequested).toBe("jev-1.13.0");
    expect(record.repeatIndex).toBe(1);
    expect(record.repeatCount).toBe(1);
    expect(record.modelReturned).toBe("jev-1.13.0");
    expect(record.policyHash).toBe(TYPESAFE_POLICY_HASH);
    expect(record.stateFingerprint).toHaveLength(64);
    expect(record.routing.questionIds).toHaveLength(10);
    expect(record.evidence.questionIds).toHaveLength(1);
    expect(record.baseline.erroredLenses).toEqual([]);
    expect(record.routing.signals.every((signal) => signal.answer.confidence === 0.9)).toBe(true);
    expect(record.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(record.state.candidates.some((candidate) => candidate.path === "src/game.ts")).toBe(true);
    expect(record.state.discardedCandidateSummary).toBeDefined();
    expect(JSON.stringify(record)).not.toContain("super-secret-value");
    expect(JSON.stringify(requests)).not.toContain("TYPESAFE_API_KEY");
  });

  test("selects the nearest preceding hunk for a finding in a multi-hunk file", async () => {
    const requests: SystemOneRequest[] = [];
    const multiHunk: ShadowReviewInput = {
      ...input,
      diff: `diff --git a/src/game.ts b/src/game.ts
@@ -1 +1 @@
+const first = true;
@@ -20 +20 @@
+const relevant = false;`,
      lensReports: [{
        ...input.lensReports[0]!,
        findings: [{ ...input.lensReports[0]!.findings[0]!, line: 20 }],
      }],
    };
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest(),
      transport: successfulTransport(requests),
      sink: { write: () => undefined },
    });

    await observer.observe(multiHunk);

    const evidenceRequest = requests.find((request) => "findings" in (request.state as object));
    const evidenceState = evidenceRequest!.state as {
      findings: Array<{ selectedEvidence: { candidateId: string; excerpt: string } }>;
    };
    expect(evidenceState.findings[0]?.selectedEvidence.candidateId).toBe("candidate_2");
    expect(evidenceState.findings[0]?.selectedEvidence.excerpt).toContain("relevant");
  });

  test("records failed baseline lenses but does not triage their synthetic diagnostics", async () => {
    const records: ShadowComparisonRecord[] = [];
    const requests: SystemOneRequest[] = [];
    const erroredInput: ShadowReviewInput = {
      ...input,
      lensReports: [{
        ...input.lensReports[0]!,
        errored: true,
      }],
    };
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest(),
      transport: successfulTransport(requests),
      sink: { write: (record) => records.push(record) },
    });

    await observer.observe(erroredInput);

    expect(requests).toHaveLength(1);
    expect(records[0]?.baseline.erroredLenses).toEqual(["Architecture"]);
    expect(records[0]?.evidence.status).toBe("skipped");
    expect(records[0]?.evidence.signals).toEqual([]);
  });

  test("repeats TypeSafe judgments over one fixed Sage baseline", async () => {
    const records: ShadowComparisonRecord[] = [];
    const requests: SystemOneRequest[] = [];
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest(),
      transport: successfulTransport(requests),
      sink: { write: (record) => records.push(record) },
      repeatCount: 3,
      now: () => new Date("2026-09-18T21:00:00.000Z"),
    });

    await observer.observe(input);

    expect(requests).toHaveLength(6);
    expect(records.map((record) => record.repeatIndex)).toEqual([1, 2, 3]);
    expect(records.every((record) => record.repeatCount === 3)).toBe(true);
    expect(new Set(records.map((record) => record.recordId)).size).toBe(3);
    expect(new Set(records.map((record) => record.stateFingerprint)).size).toBe(1);
    expect(new Set(records.map((record) => record.baseline.findingFingerprint)).size).toBe(1);
  });

  test("off mode performs no network or persistence", async () => {
    let calls = 0;
    let writes = 0;
    const observer = createTypeSafeShadowObserver({
      mode: "off",
      corpus: manifest(),
      transport: { execute: async () => { calls++; return {}; } },
      sink: { write: () => { writes++; } },
    });
    await observer.observe(input);
    expect(calls).toBe(0);
    expect(writes).toBe(0);
  });

  test("pending approval records a failure without network access", async () => {
    let calls = 0;
    const records: ShadowComparisonRecord[] = [];
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest("pending"),
      transport: { execute: async () => { calls++; return {}; } },
      sink: { write: (record) => records.push(record) },
    });
    await observer.observe(input);
    expect(calls).toBe(0);
    expect(records[0]?.failureReason).toContain("approval is pending");
  });

  test("a changed head SHA is rejected before network access", async () => {
    let calls = 0;
    const records: ShadowComparisonRecord[] = [];
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest(),
      transport: { execute: async () => { calls++; return {}; } },
      sink: { write: (record) => records.push(record) },
    });
    await observer.observe({
      ...input,
      pr: { ...input.pr, headRefOid: "b".repeat(40) },
    });
    expect(calls).toBe(0);
    expect(records[0]?.failureReason).toContain("immutable corpus SHA");
  });

  test("timeout and malformed responses fail open into structured records", async () => {
    const timeoutRecords: ShadowComparisonRecord[] = [];
    const timeoutObserver = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest(),
      transport: { execute: async () => new Promise(() => undefined) },
      sink: { write: (record) => timeoutRecords.push(record) },
      timeoutMs: 5,
    });
    await timeoutObserver.observe(input);
    expect(timeoutRecords[0]?.failureReason).toContain("timed out");

    const malformedRecords: ShadowComparisonRecord[] = [];
    const malformedObserver = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest(),
      transport: {
        execute: async (request) => ({
          model: request.model,
          answers: {},
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      },
      sink: { write: (record) => malformedRecords.push(record) },
    });
    await malformedObserver.observe(input);
    expect(malformedRecords[0]?.routing.status).toBe("failed");
    expect(malformedRecords[0]?.failureReason).toContain("missing answer");
  });

  test("low-confidence answers are retained but never accepted", async () => {
    const records: ShadowComparisonRecord[] = [];
    const observer = createTypeSafeShadowObserver({
      mode: "shadow",
      corpus: manifest(),
      transport: successfulTransport([], 0.4),
      sink: { write: (record) => records.push(record) },
    });
    await observer.observe(input);
    expect(records[0]?.routing.signals.every((signal) => signal.disposition === "low_confidence")).toBe(true);
    expect(records[0]?.evidence.signals[0]?.disposition).toBe("low_confidence");
  });
});
