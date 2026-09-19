import { z } from "zod";

import type { RecordedSignal, ShadowComparisonRecord } from "./types.ts";

export const ReviewerLabelSchema = z.object({
  recordId: z.string().min(1),
  questionId: z.string().min(1),
  reviewer: z.string().min(1),
  usefulness: z.enum(["useful", "not_useful", "indeterminate"]),
  evidenceSufficient: z.boolean(),
  groundTruthPositive: z.boolean().optional(),
});

export type ReviewerLabel = z.infer<typeof ReviewerLabelSchema>;

export const EvaluationThresholdsSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("approved"),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime(),
    minimumLabels: z.number().int().positive(),
    stopBelowPrecision: z.number().min(0).max(1),
    proposeMinimumPrecision: z.number().min(0).max(1),
    proposeMinimumUsefulness: z.number().min(0).max(1),
    proposeMaximumFailureRate: z.number().min(0).max(1),
    proposeMaximumCostUsdPerRecord: z.number().nonnegative(),
    proposeMaximumP95LatencyMs: z.number().int().positive(),
    proposeMinimumRepeatAgreement: z.number().min(0).max(1),
    proposeMaximumProbabilitySpread: z.number().min(0).max(1),
  }),
]);

export type EvaluationThresholds = z.infer<typeof EvaluationThresholdsSchema>;

export interface QuestionEvaluation {
  questionId: string;
  labeled: number;
  useful: number;
  notUseful: number;
  indeterminate: number;
  evidenceSufficient: number;
  precision: number | null;
  recall: number | null;
}

export interface EvaluationReport {
  records: number;
  immutableStates: number;
  baselineLensRuns: number;
  baselineFailedLensRuns: number;
  labelCoverage: {
    requiredSignals: number;
    labeledSignals: number;
    unlabeledSignals: number;
    groundTruthSignals: number;
    missingGroundTruthSignals: number;
  };
  failedRecords: number;
  truncatedRecords: number;
  requests: number;
  retries: number;
  latencyMs: { p50: number; p95: number };
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  repeatability: {
    repeatedGroups: number;
    meanAgreement: number | null;
    maxProbabilitySpread: number | null;
  };
  questions: QuestionEvaluation[];
  recommendation: "stop" | "iterate" | "propose_separately_authorized_integration";
  recommendationReason: string;
  thresholdStatus: EvaluationThresholds["status"];
}

function allSignals(record: ShadowComparisonRecord): RecordedSignal[] {
  return [...record.routing.signals, ...record.evidence.signals];
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
}

function predictedPositive(signal: RecordedSignal): boolean {
  if (signal.disposition !== "accepted") return false;
  return signal.answer.choice === "recommend" || signal.answer.choice === "supported";
}

function questionEvaluations(
  records: readonly ShadowComparisonRecord[],
  labels: readonly ReviewerLabel[],
): QuestionEvaluation[] {
  const signalByKey = new Map<string, RecordedSignal>();
  for (const record of records) {
    for (const signal of allSignals(record)) {
      signalByKey.set(`${record.recordId}:${signal.questionId}`, signal);
    }
  }
  const grouped = new Map<string, ReviewerLabel[]>();
  for (const label of labels) {
    const key = `${label.recordId}:${label.questionId}`;
    const signal = signalByKey.get(key);
    if (!signal) throw new Error(`label references missing signal ${key}`);
    const values = grouped.get(signal.policyQuestionId) ?? [];
    values.push(label);
    grouped.set(signal.policyQuestionId, values);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([questionId, questionLabels]) => {
      let truePositive = 0;
      let falsePositive = 0;
      let falseNegative = 0;
      for (const label of questionLabels) {
        if (label.groundTruthPositive === undefined) continue;
        const signal = signalByKey.get(`${label.recordId}:${label.questionId}`)!;
        const predicted = predictedPositive(signal);
        if (predicted && label.groundTruthPositive) truePositive++;
        if (predicted && !label.groundTruthPositive) falsePositive++;
        if (!predicted && label.groundTruthPositive) falseNegative++;
      }
      const precisionDenominator = truePositive + falsePositive;
      const recallDenominator = truePositive + falseNegative;
      return {
        questionId,
        labeled: questionLabels.length,
        useful: questionLabels.filter((label) => label.usefulness === "useful").length,
        notUseful: questionLabels.filter((label) => label.usefulness === "not_useful").length,
        indeterminate: questionLabels.filter((label) => label.usefulness === "indeterminate").length,
        evidenceSufficient: questionLabels.filter((label) => label.evidenceSufficient).length,
        precision: precisionDenominator > 0 ? truePositive / precisionDenominator : null,
        recall: recallDenominator > 0 ? truePositive / recallDenominator : null,
      };
    });
}

function repeatability(records: readonly ShadowComparisonRecord[]): EvaluationReport["repeatability"] {
  const groups = new Map<string, RecordedSignal[]>();
  for (const record of records) {
    for (const signal of allSignals(record).filter(
      (candidate) =>
        candidate.family === "routing" || candidate.family === "finding_evidence",
    )) {
      const key = `${record.stateFingerprint}:${record.policyHash}:${record.modelRequested}:${signal.questionId}`;
      const values = groups.get(key) ?? [];
      values.push(signal);
      groups.set(key, values);
    }
  }
  const repeated = [...groups.values()].filter((signals) => signals.length > 1);
  if (repeated.length === 0) {
    return { repeatedGroups: 0, meanAgreement: null, maxProbabilitySpread: null };
  }
  const agreements: number[] = [];
  let maxProbabilitySpread = 0;
  for (const signals of repeated) {
    const counts = new Map<string, number>();
    for (const signal of signals) {
      counts.set(signal.answer.choice, (counts.get(signal.answer.choice) ?? 0) + 1);
    }
    agreements.push(Math.max(...counts.values()) / signals.length);
    const options = new Set(signals.flatMap((signal) => Object.keys(signal.answer.probabilities)));
    for (const option of options) {
      const probabilities = signals.map((signal) => signal.answer.probabilities[option] ?? 0);
      maxProbabilitySpread = Math.max(
        maxProbabilitySpread,
        Math.max(...probabilities) - Math.min(...probabilities),
      );
    }
  }
  return {
    repeatedGroups: repeated.length,
    meanAgreement: agreements.reduce((sum, value) => sum + value, 0) / agreements.length,
    maxProbabilitySpread,
  };
}

export function generateEvaluationReport(
  records: readonly ShadowComparisonRecord[],
  rawLabels: readonly ReviewerLabel[],
  rawThresholds: EvaluationThresholds = { status: "pending" },
): EvaluationReport {
  const labels = rawLabels.map((label) => ReviewerLabelSchema.parse(label));
  const thresholds = EvaluationThresholdsSchema.parse(rawThresholds);
  const questions = questionEvaluations(records, labels);
  const signalByKey = new Map<string, RecordedSignal>();
  for (const record of records) {
    for (const signal of allSignals(record)) {
      signalByKey.set(`${record.recordId}:${signal.questionId}`, signal);
    }
  }
  const decisionSignalKeys = new Set(
    [...signalByKey.entries()]
      .filter(([, signal]) => signal.family === "routing" || signal.family === "finding_evidence")
      .map(([key]) => key),
  );
  const decisionLabels = labels.filter((label) =>
    decisionSignalKeys.has(`${label.recordId}:${label.questionId}`));
  const labeledDecisionKeys = new Set(
    decisionLabels.map((label) => `${label.recordId}:${label.questionId}`),
  );
  const groundTruthDecisionKeys = new Set(
    decisionLabels
      .filter((label) => label.groundTruthPositive !== undefined)
      .map((label) => `${label.recordId}:${label.questionId}`),
  );
  const decisionQuestionIds = new Set(
    [...signalByKey.values()]
      .filter((signal) => signal.family === "routing" || signal.family === "finding_evidence")
      .map((signal) => signal.policyQuestionId),
  );
  const decisionQuestions = questions.filter((question) => decisionQuestionIds.has(question.questionId));
  const labeled = labeledDecisionKeys.size;
  const useful = decisionLabels.filter((label) => label.usefulness === "useful").length;
  const decidedLabels = decisionLabels.filter(
    (label) => label.usefulness === "useful" || label.usefulness === "not_useful",
  ).length;
  const precisionValues = decisionQuestions
    .map((question) => question.precision)
    .filter((value): value is number => value !== null);
  const meanPrecision =
    precisionValues.length > 0
      ? precisionValues.reduce((sum, value) => sum + value, 0) / precisionValues.length
      : null;
  const failedRecords = records.filter((record) => record.failureReason !== null).length;
  const failureRate = records.length > 0 ? failedRecords / records.length : 1;
  const usefulnessRate = decidedLabels > 0 ? useful / decidedLabels : 0;
  const averageCostUsd = records.length > 0
    ? records.reduce((sum, record) => sum + record.estimatedCostUsd, 0) / records.length
    : Number.POSITIVE_INFINITY;
  const repeat = repeatability(records);
  const p95LatencyMs = percentile(records.map((record) => record.latencyMs), 0.95);
  const unlabeledSignals = decisionSignalKeys.size - labeledDecisionKeys.size;
  const missingGroundTruthSignals = decisionSignalKeys.size - groundTruthDecisionKeys.size;
  // repeatIndex > 1 reuses the exact same completed Sage baseline. Count the
  // baseline once per observer invocation while still counting every Jev
  // decision above for label coverage and repeatability.
  const baselineRecords = records.filter((record) => (record.repeatIndex ?? 1) === 1);
  const baselineFailedLensRuns = baselineRecords.reduce(
    (sum, record) => sum + record.baseline.erroredLenses.length,
    0,
  );

  let recommendation: EvaluationReport["recommendation"] = "iterate";
  let recommendationReason =
    thresholds.status === "pending"
      ? "Usefulness and cost thresholds have not been approved; production cannot be proposed."
      : "More independently labeled corpus evidence is required.";
  if (
    thresholds.status === "approved" &&
    groundTruthDecisionKeys.size >= thresholds.minimumLabels &&
    (meanPrecision ?? 0) < thresholds.stopBelowPrecision
  ) {
    recommendation = "stop";
    recommendationReason = "Reviewer-validated mean precision is below the stop threshold.";
  } else if (
    thresholds.status === "approved" &&
    groundTruthDecisionKeys.size >= thresholds.minimumLabels &&
    (meanPrecision ?? 0) >= thresholds.proposeMinimumPrecision &&
    usefulnessRate >= thresholds.proposeMinimumUsefulness &&
    failureRate <= thresholds.proposeMaximumFailureRate &&
    averageCostUsd <= thresholds.proposeMaximumCostUsdPerRecord &&
    p95LatencyMs <= thresholds.proposeMaximumP95LatencyMs &&
    repeat.meanAgreement !== null &&
    repeat.meanAgreement >= thresholds.proposeMinimumRepeatAgreement &&
    repeat.maxProbabilitySpread !== null &&
    repeat.maxProbabilitySpread <= thresholds.proposeMaximumProbabilitySpread &&
    decisionSignalKeys.size > 0 &&
    unlabeledSignals === 0 &&
    missingGroundTruthSignals === 0 &&
    baselineFailedLensRuns === 0
  ) {
    recommendation = "propose_separately_authorized_integration";
    recommendationReason =
      "The bounded corpus cleared the predeclared precision, usefulness, failure, cost, latency, and repeatability thresholds.";
  } else if (thresholds.status === "approved" && labeled > 0) {
    recommendationReason =
      "The labeled evidence does not yet clear either the stop or production-proposal threshold.";
  }

  return {
    records: records.length,
    immutableStates: new Set(records.map((record) => record.stateFingerprint)).size,
    baselineLensRuns: baselineRecords.reduce(
      (sum, record) => sum + record.baseline.selectedLenses.length,
      0,
    ),
    baselineFailedLensRuns,
    labelCoverage: {
      requiredSignals: decisionSignalKeys.size,
      labeledSignals: labeledDecisionKeys.size,
      unlabeledSignals,
      groundTruthSignals: groundTruthDecisionKeys.size,
      missingGroundTruthSignals,
    },
    failedRecords,
    truncatedRecords: records.filter((record) => record.state.truncation.stateTruncated).length,
    requests: records.reduce(
      (sum, record) => sum + record.routing.attempts + record.evidence.attempts,
      0,
    ),
    retries: records.reduce(
      (sum, record) => sum + record.routing.retryCount + record.evidence.retryCount,
      0,
    ),
    latencyMs: {
      p50: percentile(records.map((record) => record.latencyMs), 0.5),
      p95: p95LatencyMs,
    },
    usage: {
      inputTokens: records.reduce((sum, record) => sum + record.usage.inputTokens, 0),
      outputTokens: records.reduce((sum, record) => sum + record.usage.outputTokens, 0),
      estimatedCostUsd: records.reduce((sum, record) => sum + record.estimatedCostUsd, 0),
    },
    repeatability: repeat,
    questions,
    recommendation,
    recommendationReason,
    thresholdStatus: thresholds.status,
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

export function renderEvaluationReport(report: EvaluationReport): string {
  const questionRows = report.questions
    .map(
      (question) =>
        `| ${question.questionId} | ${question.labeled} | ${question.useful} | ${question.notUseful} | ${question.indeterminate} | ${question.evidenceSufficient} | ${formatMetric(question.precision)} | ${formatMetric(question.recall)} |`,
    )
    .join("\n");
  return `# TypeSafe shadow proof-of-value report

## Coverage and operations

- Records: ${report.records}
- Immutable states: ${report.immutableStates}
- Completed baseline Lens runs observed: ${report.baselineLensRuns}
- Failed baseline lens runs: ${report.baselineFailedLensRuns}
- Independently labeled decision signals: ${report.labelCoverage.labeledSignals} / ${report.labelCoverage.requiredSignals} (${report.labelCoverage.unlabeledSignals} missing)
- Decision signals with ground truth: ${report.labelCoverage.groundTruthSignals} / ${report.labelCoverage.requiredSignals} (${report.labelCoverage.missingGroundTruthSignals} missing)
- Failed records: ${report.failedRecords}
- State-truncated records: ${report.truncatedRecords}
- Provider request attempts / retries: ${report.requests} / ${report.retries}
- Latency p50 / p95: ${report.latencyMs.p50} ms / ${report.latencyMs.p95} ms
- Usage: ${report.usage.inputTokens} input tokens, ${report.usage.outputTokens} output tokens
- Estimated provider cost: $${report.usage.estimatedCostUsd.toFixed(6)}

## Repeatability

- Repeated state/question groups: ${report.repeatability.repeatedGroups}
- Mean exact-choice agreement: ${formatMetric(report.repeatability.meanAgreement)}
- Maximum probability spread: ${formatMetric(report.repeatability.maxProbabilitySpread)}

## Independent reviewer labels

| Question | Labeled | Useful | Not useful | Indeterminate | Evidence sufficient | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${questionRows || "| n/a | 0 | 0 | 0 | 0 | 0 | n/a | n/a |"}

## Recommendation

Threshold status: **${report.thresholdStatus}**

**${report.recommendation}** — ${report.recommendationReason}
`;
}
