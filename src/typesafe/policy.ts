import { createHash } from "node:crypto";
import { z } from "zod";

import rawPolicy from "./policy.json";

const RoutingQuestionSchema = z.object({
  id: z.string().min(1),
  lens: z.enum([
    "Security",
    "Architecture",
    "EcosystemCompliance",
    "Performance",
    "Maintainability",
  ]),
  purpose: z.string().min(1),
  scopeSelector: z.string().min(1),
  contextRule: z.string().min(1),
  candidateFloor: z.number().min(0).max(1),
  criteria: z.object({
    recommend: z.string().min(1),
    do_not_recommend: z.string().min(1),
    no_signal: z.string().min(1),
  }),
});

const CommentHygieneSchema = z.object({
  id: z.string().min(1),
  candidateFloor: z.number().min(0).max(1),
  docstringCandidateFloor: z.number().min(0).max(1),
  maxSpans: z.number().int().positive(),
  maxSpanChars: z.number().int().positive(),
  maxDeclarationContextChars: z.number().int().positive(),
  maxStateChars: z.number().int().positive(),
  criteria: z.object({
    change_history: z.string().min(1),
    planning_context: z.string().min(1),
    code_restatement: z.string().min(1),
    mechanism_over_rationale: z.string().min(1),
    ephemeral_context: z.string().min(1),
    filler_jargon: z.string().min(1),
    none: z.string().min(1),
  }),
});

const PolicySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.string().min(1),
  model: z.string().regex(/^jev-\d+\.\d+\.\d+$/, "model must be a pinned Jev version"),
  calibration: z.object({
    status: z.literal("uncalibrated"),
    corpusVersion: z.null(),
  }),
  pricing: z.object({
    inputUsdPerMillionTokens: z.number().nonnegative(),
    outputUsdPerMillionTokens: z.number().nonnegative(),
  }),
  bounds: z.object({
    maxCandidates: z.number().int().positive(),
    maxCandidateChars: z.number().int().positive(),
    maxStateChars: z.number().int().positive(),
  }),
  commentHygiene: CommentHygieneSchema,
  routing: z.array(RoutingQuestionSchema).length(5),
  findingEvidence: z.object({
    id: z.string().min(1),
    purpose: z.string().min(1),
    scopeSelector: z.string().min(1),
    contextRule: z.string().min(1),
    candidateFloor: z.number().min(0).max(1),
    criteria: z.object({
      supported: z.string().min(1),
      insufficient_evidence: z.string().min(1),
      contradicted: z.string().min(1),
    }),
  }),
});

export const TYPESAFE_POLICY = PolicySchema.parse(rawPolicy);
export type TypeSafePolicy = z.infer<typeof PolicySchema>;
export type RoutingPolicy = z.infer<typeof RoutingQuestionSchema>;

export const TYPESAFE_POLICY_HASH = createHash("sha256")
  .update(JSON.stringify(TYPESAFE_POLICY))
  .digest("hex");
