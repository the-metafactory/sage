import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizeCorpusInput,
  CorpusManifestSchema,
  loadCorpusManifest,
} from "../src/typesafe/corpus.ts";
import { createFileShadowSink } from "../src/typesafe/persist.ts";
import {
  generateEvaluationReport,
  renderEvaluationReport,
  type EvaluationThresholds,
  type ReviewerLabel,
} from "../src/typesafe/report.ts";
import type { ShadowComparisonRecord } from "../src/typesafe/types.ts";
import { ShadowComparisonRecordSchema } from "../src/typesafe/types.ts";

function record(id: string, choice: "recommend" | "do_not_recommend", probability: number): ShadowComparisonRecord {
  return {
    schemaVersion: 1,
    recordId: id,
    createdAt: "2026-09-18T20:00:00.000Z",
    mode: "shadow",
    authorizationMode: "frozen-corpus",
    repeatIndex: 1,
    repeatCount: 2,
    ref: { owner: "x", repo: "game", number: 1 },
    headSha: "a".repeat(40),
    modelRequested: "jev-1.13.0",
    modelReturned: "jev-1.13.0",
    policyVersion: "v1",
    policyHash: "policy",
    stateFingerprint: "same-state",
    baseline: {
      selectedLenses: ["CodeQuality", "Security"],
      erroredLenses: [],
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

  test("allows only explicitly approved game repositories in until-revoked mode", () => {
    const manifest = CorpusManifestSchema.parse({
      schemaVersion: 1,
      authorizationMode: "approved-repositories-until-revoked",
      frozenAt: null,
      dataProcessingApproval: {
        status: "approved",
        approvedBy: "principal",
        approvedAt: "2026-09-19T06:00:00.000Z",
        scope: "approved non-critical game repositories until revoked",
        termsReviewedAt: "2026-09-18T20:00:00.000Z",
      },
      entries: [],
      repositories: [{
        owner: "x",
        repo: "game",
        classification: "non-critical-game",
        approvedBy: "principal",
        approvedAt: "2026-09-19T06:00:00.000Z",
      }],
    });

    expect(manifest.authorizationMode).toBe("approved-repositories-until-revoked");
    const approvedInput = {
      ref: { owner: "x", repo: "game", number: 99 },
      pr: {
        number: 99,
        title: "game change",
        body: "",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefName: "feature",
        headRefOid: "b".repeat(40),
        author: { login: "principal" },
        changedFiles: 0,
        additions: 0,
        deletions: 0,
        files: [],
        url: "https://github.com/x/game/pull/99",
      },
      diff: "",
      selectedLensNames: [],
      lensReports: [],
      verdict: { decision: "approved", summary: "clean", lenses: [] },
      posted: false,
    } as const;
    expect(authorizeCorpusInput(manifest, {
      ref: approvedInput.ref,
      headSha: approvedInput.pr.headRefOid,
    })).toEqual({ ok: true });
    expect(authorizeCorpusInput(manifest, {
      ref: { ...approvedInput.ref, repo: "customer" },
      headSha: approvedInput.pr.headRefOid,
    })).toEqual({
      ok: false,
      reason: "repository is not in the until-revoked game allowlist",
    });
  });

  test("rejects until-revoked mode without an explicit repository allowlist", () => {
    expect(() => CorpusManifestSchema.parse({
      schemaVersion: 1,
      authorizationMode: "approved-repositories-until-revoked",
      frozenAt: null,
      dataProcessingApproval: {
        status: "approved",
        approvedBy: "principal",
        approvedAt: "2026-09-19T06:00:00.000Z",
        scope: "game repositories",
        termsReviewedAt: "2026-09-18T20:00:00.000Z",
      },
      entries: [],
      repositories: [],
    })).toThrow(/requires at least one approved repository/);
  });

  test("requires an owner-only regular file for until-revoked authorization", () => {
    const root = mkdtempSync(join(tmpdir(), "sage-typesafe-manifest-"));
    const path = join(root, "authorization.json");
    const link = join(root, "authorization-link.json");
    const contents = JSON.stringify({
      schemaVersion: 1,
      authorizationMode: "approved-repositories-until-revoked",
      frozenAt: null,
      dataProcessingApproval: {
        status: "approved",
        approvedBy: "principal",
        approvedAt: "2026-09-19T06:00:00.000Z",
        scope: "approved game repositories",
        termsReviewedAt: "2026-09-18T20:00:00.000Z",
      },
      entries: [],
      repositories: [{
        owner: "x",
        repo: "game",
        classification: "non-critical-game",
        approvedBy: "principal",
        approvedAt: "2026-09-19T06:00:00.000Z",
      }],
    });
    try {
      writeFileSync(path, contents);
      chmodSync(path, 0o640);
      expect(() => loadCorpusManifest(path)).toThrow(/mode 600/);
      chmodSync(path, 0o600);
      expect(loadCorpusManifest(path).authorizationMode)
        .toBe("approved-repositories-until-revoked");
      symlinkSync(path, link);
      expect(() => loadCorpusManifest(link)).toThrow(/must not be a symbolic link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(report.baselineFailedLensRuns).toBe(0);
    expect(report.labelCoverage).toEqual({
      requiredSignals: 2,
      labeledSignals: 2,
      unlabeledSignals: 0,
      groundTruthSignals: 2,
      missingGroundTruthSignals: 0,
    });
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
    expect(markdown).toContain("candidate-selection helper signals");
    expect(markdown).toContain("covers 1 immutable state(s)");
    expect(markdown).toContain("State-truncated records: 0 / 2 (0.000)");
  });

  test("counts one fixed Sage baseline once across repeated Jev judgments", () => {
    const first = record("r1", "recommend", 0.9);
    const repeated = { ...record("r2", "recommend", 0.8), repeatIndex: 2 };
    const report = generateEvaluationReport([first, repeated], []);

    expect(report.records).toBe(2);
    expect(report.baselineLensRuns).toBe(2);
    expect(report.baselineFailedLensRuns).toBe(0);
    expect(report.labelCoverage.requiredSignals).toBe(2);
  });

  test("renders a missing truncation rate as N/A when there are no records", () => {
    const markdown = renderEvaluationReport(generateEvaluationReport([], []));
    expect(markdown).toContain("State-truncated records: 0 / 0 (N/A)");
  });

  test("excludes candidate helper choices from the repeatability gate", () => {
    const firstBase = record("r1", "recommend", 0.9);
    const secondBase = record("r2", "recommend", 0.7);
    const withCandidate = (
      base: ShadowComparisonRecord,
      choice: "candidate_1" | "candidate_2",
    ): ShadowComparisonRecord => ({
      ...base,
      routing: {
        ...base.routing,
        signals: [...base.routing.signals, {
          ...base.routing.signals[0]!,
          questionId: "lens.security.v1.candidate",
          family: "candidate",
          answer: {
            type: "choice",
            choice,
            probabilities: choice === "candidate_1"
              ? { candidate_1: 0.99, candidate_2: 0.01 }
              : { candidate_1: 0.01, candidate_2: 0.99 },
            confidence: 0.99,
          },
        }],
      },
    });
    const first = withCandidate(firstBase, "candidate_1");
    const second = withCandidate(secondBase, "candidate_2");

    const repeatability = generateEvaluationReport([first, second], []).repeatability;
    expect(repeatability.repeatedGroups).toBe(1);
    expect(repeatability.meanAgreement).toBe(1);
    expect(repeatability.maxProbabilitySpread).toBeCloseTo(0.2);
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

    const incompleteThresholds = { ...approvedThresholds, minimumLabels: 1 };
    const incomplete = generateEvaluationReport(records, labels.slice(0, 1), incompleteThresholds);
    expect(incomplete.labelCoverage.unlabeledSignals).toBe(1);
    expect(incomplete.recommendation).toBe("iterate");

    const labelsWithoutGroundTruth = labels.map(({ groundTruthPositive: _removed, ...label }) => label);
    const unscored = generateEvaluationReport(records, labelsWithoutGroundTruth, approvedThresholds);
    expect(unscored.labelCoverage.labeledSignals).toBe(2);
    expect(unscored.labelCoverage.groundTruthSignals).toBe(0);
    expect(unscored.recommendation).toBe("iterate");

    const incompleteBaseline = records.map((item, index) => index === 0
      ? { ...item, baseline: { ...item.baseline, erroredLenses: ["CodeQuality"] } }
      : item);
    const baselineReport = generateEvaluationReport(incompleteBaseline, labels, approvedThresholds);
    expect(baselineReport.baselineFailedLensRuns).toBe(1);
    expect(baselineReport.recommendation).toBe("iterate");

    const omittedEvidence = records.map((item) => ({
      ...item,
      evidence: { ...item.evidence, omittedQuestionCount: 1 },
    }));
    const omittedReport = generateEvaluationReport(omittedEvidence, labels, approvedThresholds);
    expect(omittedReport.omittedEvidenceQuestions).toBe(2);
    expect(omittedReport.recommendation).toBe("iterate");
  });

  test("rejects mixed cohorts and duplicate signal labels", () => {
    const first = record("r1", "recommend", 0.9);
    const second = { ...record("r2", "recommend", 0.8), policyHash: "different-policy" };
    expect(() => generateEvaluationReport([first, second], [])).toThrow(/share one model/);

    const label: ReviewerLabel = {
      recordId: first.recordId,
      questionId: "lens.security.v1",
      reviewer: "independent-reviewer",
      usefulness: "useful",
      evidenceSufficient: true,
      groundTruthPositive: true,
    };
    expect(() => generateEvaluationReport([first], [label, label])).toThrow(/duplicate reviewer label/);
  });

  test("strictly validates persisted records at the report boundary", () => {
    expect(ShadowComparisonRecordSchema.parse(record("r1", "recommend", 0.9)).recordId).toBe("r1");
    expect(() => ShadowComparisonRecordSchema.parse({
      ...record("r1", "recommend", 0.9),
      unexpected: true,
    })).toThrow();
    expect(() => ShadowComparisonRecordSchema.parse({
      ...record("r1", "recommend", 0.9),
      routing: { ...record("r1", "recommend", 0.9).routing, latencyMs: "fast" },
    })).toThrow();
  });
});

describe("TypeSafe record persistence", () => {
  test("does not overwrite identical records created in the same millisecond", () => {
    const root = mkdtempSync(join(tmpdir(), "sage-typesafe-records-"));
    try {
      const sink = createFileShadowSink(root);
      const sameRecord = record("record-one", "recommend", 0.9);
      sink.write(sameRecord);
      sink.write(sameRecord);
      expect(readdirSync(root)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
