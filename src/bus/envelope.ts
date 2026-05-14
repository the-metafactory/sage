import { z } from "zod";
import { randomUUID } from "node:crypto";

import { deriveSubject as upstreamDeriveSubject } from "@the-metafactory/myelin/subjects";

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

/**
 * Generic over the payload type so callers with a precise interface (e.g.
 * `DispatchTaskPayload`) don't have to launder through
 * `as unknown as Record<string, unknown>`. The constraint is `object` (any
 * non-null reference type), not `Record<string, unknown>`, because a closed
 * interface without an explicit index signature isn't assignable to Record
 * — and forcing every payload type to carry an index signature weakens the
 * sender-side contract for no real gain. The Zod parse at the end of
 * `buildEnvelope` validates the runtime shape, so the compile-time cast at
 * the schema boundary is safe.
 *
 * Default `Record<string, unknown>` preserves the prior call-style for
 * existing untyped sites.
 */
export interface BuildEnvelopeInput<P extends object = Record<string, unknown>> {
  source: string;
  type: string;
  payload: P;
  sovereignty?: Partial<Sovereignty>;
  correlationId?: string;
  extensions?: Record<string, unknown>;
}

export function buildEnvelope<P extends object = Record<string, unknown>>(
  input: BuildEnvelopeInput<P>,
): Envelope {
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
    // Single structural cast localized to the schema-parse boundary. Zod's
    // `EnvelopeSchema.parse` below enforces the runtime contract
    // (`payload: z.record(z.unknown())`), rejecting null, undefined, and
    // arrays — so a structurally incompatible payload fails fast here
    // rather than silently downstream. Exotic objects (Date, Map, class
    // instances) DO satisfy `z.record(z.unknown())` and reach the bus, but
    // those are caller bugs the type system already discourages.
    payload: input.payload as Record<string, unknown>,
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.extensions ? { extensions: input.extensions } : {}),
  };

  return EnvelopeSchema.parse(env);
}

/**
 * Derive NATS subject from envelope per myelin/specs/namespace.md.
 *
 * Thin shim around `@the-metafactory/myelin/subjects.deriveSubject` —
 * upstream owns the rules (5-segment `{classification}.{org}.{type}` and
 * 6-segment `{classification}.{org}.{stack}.{type}`), Sage just
 * destructures the envelope into the upstream arg list.
 *
 * The shim shape was adopted in sage#22 — pre-fix Sage carried its own
 * port of the 5-segment form, which would have broken silently when the
 * myelin-side stack-aware TASKS stream filter (cortex#138) shipped 6-
 * segment subjects. Routing through upstream means Sage tracks myelin's
 * subject grammar automatically.
 *
 * The empty-org-segment guard is preserved here because upstream
 * accepts any string for `org`; Sage's `source` regex already rejects
 * empty first segments, but a defensive check at the daemon's
 * publish-side surface stays cheap.
 */
export function deriveSubject(env: Envelope, stack?: string): string {
  if (env.sovereignty.classification === "public") {
    return upstreamDeriveSubject("public", "", env.type);
  }
  const org = env.source.split(".")[0];
  if (!org) throw new Error(`invalid source for subject derivation: ${env.source}`);
  return upstreamDeriveSubject(env.sovereignty.classification, org, env.type, stack);
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
