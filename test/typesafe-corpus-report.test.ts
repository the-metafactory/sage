import { describe, expect, test } from "bun:test";

import { CorpusManifestSchema } from "../src/typesafe/corpus.ts";
import {
  generateEvaluationReport,
  renderEvaluationReport,
  type EvaluationThresholds,
  type ReviewerLabel,
} from "../src/typesafe/report.ts";
import type { ShadowComparisonRecord } from "../src/typesafe/types.ts";

function record(id: string, choice: "recommend" | "do_not_recommend", probability: number): ShadowComparisonRecord {
  return {
    schemaVersion: 1,
    recordId: id,
    createdAt: "2026-09-18T20:00:00.000Z",
    mode: "shadow",
    ref: { owner: "x", repo: "game", number: 1 },
    headSha: "a".repeat(40),
    modelRequested: "jev-1.13.0",
    modelReturned: "jev-1.13.0",
    policyVersion: "v1",
    policyHash: "policy",
    stateFingerprint: "same-state",
    baseline: {
      selectedLenses: ["CodeQuality", "Security"],
      findingFingerprint: "findings",
      verdictDecision: "approved",
      posted: false,
    },
    state: {
      pr: { title: "game", changedPaths: ["src/game.ts"], additions: 1, deletions: 0, headSha: "a".repeat(40) },
      candidates: [],
      discardedCandidateSummary: { count: 0, paths: [], reason: "none" },
      truncation: { inputChars: 10, retainedChars: 10, candidatesTruncated: 0, stateTruncated: false },
    },
    routing: {
      status: "ok",
      latencyMs: 10,
      attempts: 1,
      retryCount: 0,
      usage: { inputTokens: 100, outputTokens: 5 },
      questionIds: ["lens.security.v1"],
      signals: [{
        questionId: "lens.security.v1",
        policyQuestionId: "lens.security.v1",
        family: "routing",
        subject: "Security",
        answer: {
          type: "choice",
          choice,
          probabilities: { recommend: probability, do_not_recommend: 1 - probability },
          confidence: Math.max(probability, 1 - probability),
        },
        floor: 0.6,
        disposition: "accepted",
      }],
      failureReason: null,
    },
    evidence: {
      status: "skipped",
      latencyMs: 0,
      attempts: 0,
      retryCount: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      questionIds: [],
      signals: [],
      failureReason: "no blocker or important findings",
    },
    latencyMs: 10,
    usage: { inputTokens: 100, outputTokens: 5 },
    estimatedCostUsd: 0.0000042,
    failureReason: null,
  };
}

describe("TypeSafe corpus manifest", () => {
  test("rejects entries while approval is pending", () => {
    expect(() => CorpusManifestSchema.parse({
      schemaVersion: 1,
      frozenAt: null,
      dataProcessingApproval: { status: "pending" },
      entries: [{
        url: "https://github.com/x/game/pull/1",
        owner: "x",
        repo: "game",
        number: 1,
        headSha: "a".repeat(40),
        classification: "non-critical-game",
        approvedBy: "principal",
        approvedAt: "2026-09-18T20:00:00.000Z",
      }],
    })).toThrow(/pending data-processing approval/);
  });
});

describe("TypeSafe evaluation report", () => {
  const approvedThresholds: EvaluationThresholds = {
    status: "approved",
    approvedBy: "principal",
    approvedAt: "2026-09-18T20:00:00.000Z",
    minimumLabels: 2,
    stopBelowPrecision: 0.5,
    proposeMinimumPrecision: 0.8,
    proposeMinimumUsefulness: 0.8,
    proposeMaximumFailureRate: 0,
    proposeMaximumCostUsdPerRecord: 0.001,
    proposeMaximumP95LatencyMs: 1000,
    proposeMinimumRepeatAgreement: 0.9,
    proposeMaximumProbabilitySpread: 0.25,
  };

  test("reports per-question labels, repeatability, costs, and a bounded recommendation", () => {
    const records = [record("r1", "recommend", 0.9), record("r2", "recommend", 0.7)];
    const labels: ReviewerLabel[] = records.map((item) => ({
      recordId: item.recordId,
      questionId: "lens.security.v1",
      reviewer: "independent-reviewer",
      usefulness: "useful",
      evidenceSufficient: true,
      groundTruthPositive: true,
    }));
    const report = generateEvaluationReport(records, labels);
    expect(report.records).toBe(2);
    expect(report.baselineLensRuns).toBe(4);
    expect(report.repeatability.repeatedGroups).toBe(1);
    expect(report.repeatability.meanAgreement).toBe(1);
    expect(report.repeatability.maxProbabilitySpread).toBeCloseTo(0.2);
    expect(report.questions[0]?.precision).toBe(1);
    expect(report.questions[0]?.recall).toBe(1);
    expect(report.usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(report.recommendation).toBe("iterate");
    expect(report.thresholdStatus).toBe("pending");
    const markdown = renderEvaluationReport(report);
    expect(markdown).toContain("Independent reviewer labels");
    expect(markdown).toContain("Maximum probability spread");
    expect(markdown).toContain("Estimated provider cost");
  });

  test("requires cost, latency, and repeatability gates before proposing integration", () => {
    const records = [record("r1", "recommend", 0.9), record("r2", "recommend", 0.8)];
    const labels: ReviewerLabel[] = records.map((item) => ({
      recordId: item.recordId,
      questionId: "lens.security.v1",
      reviewer: "independent-reviewer",
      usefulness: "useful",
      evidenceSufficient: true,
      groundTruthPositive: true,
    }));

    expect(generateEvaluationReport(records, labels, approvedThresholds).recommendation)
      .toBe("propose_separately_authorized_integration");

    const expensive = records.map((item) => ({ ...item, estimatedCostUsd: 1 }));
    expect(generateEvaluationReport(expensive, labels, approvedThresholds).recommendation)
      .toBe("iterate");

    const inconsistent = [record("r1", "recommend", 0.9), record("r2", "do_not_recommend", 0.9)];
    expect(generateEvaluationReport(inconsistent, labels, approvedThresholds).recommendation)
      .toBe("iterate");
  });
});
