import { z } from "zod";

import type {
  CompletedReviewObservation,
  CompletedReviewObserver,
} from "../lenses/completed-review-observer.ts";
import type { PrRef } from "../forge/types.ts";
import type { Verdict } from "../verdict/types.ts";

export type TypeSafeMode = "off" | "shadow";

export type ShadowReviewInput = CompletedReviewObservation;
export type TypeSafeShadowObserver = CompletedReviewObserver;

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: unknown;
  readonly criteria: Readonly<Record<string, string | null>>;
}

export interface SystemOneRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, ChoiceQuestion>>;
}

export interface TypeSafeTransport {
  execute(request: SystemOneRequest, signal: AbortSignal): Promise<unknown>;
}

export const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.number().min(0).max(1)),
  confidence: z.number().min(0).max(1),
});

export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;

export const SystemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(ChoiceAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

export interface DiffCandidate {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly excerpt: string;
  readonly selectionReason: string;
  readonly originalChars: number;
  readonly retainedChars: number;
  readonly truncated: boolean;
}

export interface BoundedReviewState {
  readonly pr: {
    readonly title: string;
    readonly changedPaths: readonly string[];
    readonly additions: number;
    readonly deletions: number;
    readonly headSha: string;
  };
  readonly candidates: readonly DiffCandidate[];
  readonly discardedCandidateSummary: {
    readonly count: number;
    readonly paths: readonly string[];
    readonly reason: string;
  };
  readonly truncation: {
    readonly inputChars: number;
    readonly retainedChars: number;
    readonly candidatesTruncated: number;
    readonly stateTruncated: boolean;
  };
}

export interface RecordedSignal {
  readonly questionId: string;
  readonly policyQuestionId: string;
  readonly family: "routing" | "candidate" | "finding_evidence";
  readonly subject: string;
  readonly answer: ChoiceAnswer;
  readonly floor: number;
  readonly disposition: "accepted" | "low_confidence" | "no_signal";
  readonly selectedCandidateId?: string;
}

export interface StageRecord {
  readonly status: "ok" | "failed" | "skipped";
  readonly latencyMs: number;
  readonly attempts: number;
  readonly retryCount: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly questionIds: readonly string[];
  readonly signals: readonly RecordedSignal[];
  readonly failureReason: string | null;
}

export interface ShadowComparisonRecord {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly createdAt: string;
  readonly mode: "shadow";
  readonly authorizationMode: "frozen-corpus" | "approved-repositories-until-revoked";
  readonly repeatIndex: number;
  readonly repeatCount: number;
  readonly ref: Readonly<PrRef>;
  readonly headSha: string;
  readonly modelRequested: string;
  readonly modelReturned: string | null;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly stateFingerprint: string;
  readonly baseline: {
    readonly selectedLenses: readonly string[];
    readonly erroredLenses: readonly string[];
    readonly findingFingerprint: string;
    readonly verdictDecision: Verdict["decision"];
    readonly posted: boolean;
  };
  readonly state: BoundedReviewState;
  readonly routing: StageRecord;
  readonly evidence: StageRecord;
  readonly latencyMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly estimatedCostUsd: number;
  readonly failureReason: string | null;
}

export interface ShadowRecordSink {
  write(record: ShadowComparisonRecord): Promise<string | void> | string | void;
}
