import { z } from "zod";
import { randomUUID } from "node:crypto";

/**
 * Myelin envelope v1 — Zod mirror of myelin/schemas/envelope.schema.json
 * Source of truth: https://myelin.metafactory.ai/schemas/envelope/v1
 */

const SourceRe = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,4}$/;
const TypeRe = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$/;
const DidRe = /^did:mf:[a-z](?:[a-z0-9._]|-(?!-))+$/;
const CapTagRe = /^[a-z](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$/;

export const SovereigntySchema = z
  .object({
    classification: z.enum(["local", "federated", "public"]),
    data_residency: z.string().regex(/^[A-Z]{2}$/),
    max_hop: z.number().int().min(0),
    frontier_ok: z.boolean(),
    model_class: z.enum(["local-only", "frontier", "any"]),
  })
  .strict();

export type Sovereignty = z.infer<typeof SovereigntySchema>;

export const EnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    source: z.string().regex(SourceRe),
    type: z.string().regex(TypeRe),
    timestamp: z.string().datetime({ offset: true }),
    correlation_id: z.string().uuid().optional(),
    sovereignty: SovereigntySchema,
    economics: z.record(z.unknown()).optional(),
    extensions: z.record(z.unknown()).optional(),
    payload: z.record(z.unknown()),
    requirements: z.array(z.string().regex(CapTagRe)).max(10).optional(),
    sovereignty_required: z.enum(["open", "selective", "strict", "bidding"]).optional(),
    deadline: z.string().datetime({ offset: true }).optional(),
    distribution_mode: z.enum(["broadcast", "direct", "delegate"]).optional(),
    target_principal: z.string().regex(DidRe).optional(),
    signed_by: z.unknown().optional(),
  })
  .strict()
  .refine(
    (e: { distribution_mode?: string; target_principal?: string }) =>
      !(e.distribution_mode === "direct" || e.distribution_mode === "delegate") ||
      Boolean(e.target_principal),
    { message: "target_principal required when distribution_mode is direct or delegate" },
  );

export type Envelope = z.infer<typeof EnvelopeSchema>;

export interface BuildEnvelopeInput {
  source: string;
  type: string;
  payload: Record<string, unknown>;
  sovereignty?: Partial<Sovereignty>;
  correlationId?: string;
  extensions?: Record<string, unknown>;
}

export function buildEnvelope(input: BuildEnvelopeInput): Envelope {
  const sovereignty: Sovereignty = {
    classification: input.sovereignty?.classification ?? "local",
    data_residency: input.sovereignty?.data_residency ?? process.env.SAGE_DATA_RESIDENCY ?? "CH",
    max_hop: input.sovereignty?.max_hop ?? 0,
    frontier_ok: input.sovereignty?.frontier_ok ?? true,
    model_class: input.sovereignty?.model_class ?? "any",
  };

  const env: Envelope = {
    id: randomUUID(),
    source: input.source,
    type: input.type,
    timestamp: new Date().toISOString(),
    sovereignty,
    payload: input.payload,
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.extensions ? { extensions: input.extensions } : {}),
  };

  return EnvelopeSchema.parse(env);
}

/**
 * Derive NATS subject from envelope per myelin/specs/namespace.md.
 *
 * - prefix from sovereignty.classification
 * - org from source's first segment (omitted for public)
 * - type field is appended as-is
 */
export function deriveSubject(env: Envelope): string {
  const prefix = env.sovereignty.classification;
  if (prefix === "public") return `public.${env.type}`;
  const org = env.source.split(".")[0];
  if (!org) throw new Error(`invalid source for subject derivation: ${env.source}`);
  return `${prefix}.${org}.${env.type}`;
}

/**
 * Encode a DID for use as an @principal segment.
 * Rules from namespace.md: `:` → `-`, `.` → `--`, `-` → `-`.
 */
export function encodeDidSegment(did: string): string {
  if (!DidRe.test(did)) throw new Error(`invalid DID: ${did}`);
  return "@" + did.replace(/:/g, "-").replace(/\./g, "--");
}

/** Validate without throwing — returns SafeParseResult shape. */
export function safeValidateEnvelope(input: unknown) {
  return EnvelopeSchema.safeParse(input);
}
