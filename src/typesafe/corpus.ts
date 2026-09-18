import { readFileSync } from "node:fs";
import { z } from "zod";

import type { ShadowReviewInput } from "./types.ts";

const CorpusEntrySchema = z.object({
  url: z.string().url(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  classification: z.literal("non-critical-game"),
  approvedBy: z.string().min(1),
  approvedAt: z.string().datetime(),
});

export const CorpusManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    frozenAt: z.string().datetime().nullable(),
    dataProcessingApproval: z.discriminatedUnion("status", [
      z.object({ status: z.literal("pending") }),
      z.object({
        status: z.literal("approved"),
        approvedBy: z.string().min(1),
        approvedAt: z.string().datetime(),
        scope: z.string().min(1),
        termsReviewedAt: z.string().datetime(),
      }),
    ]),
    entries: z.array(CorpusEntrySchema),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.dataProcessingApproval.status === "pending" && manifest.entries.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "pending data-processing approval requires an empty corpus",
      });
    }
    if (manifest.dataProcessingApproval.status === "approved" && manifest.frozenAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frozenAt"],
        message: "an approved corpus must have a freeze timestamp",
      });
    }
    for (const [index, entry] of manifest.entries.entries()) {
      const expected = `https://github.com/${entry.owner}/${entry.repo}/pull/${entry.number}`;
      if (entry.url !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "url"],
          message: `URL must exactly match ${expected}`,
        });
      }
    }
  });

export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

export function loadCorpusManifest(path: string): CorpusManifest {
  return CorpusManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function authorizeCorpusInput(
  manifest: CorpusManifest,
  input: ShadowReviewInput,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.dataProcessingApproval.status !== "approved") {
    return { ok: false, reason: "data-processing approval is pending" };
  }
  const entry = manifest.entries.find(
    (candidate) =>
      candidate.owner === input.ref.owner &&
      candidate.repo === input.ref.repo &&
      candidate.number === input.ref.number,
  );
  if (!entry) return { ok: false, reason: "PR is not present in the approved frozen corpus" };
  if (entry.headSha !== input.pr.headRefOid) {
    return { ok: false, reason: "PR head does not match the approved immutable corpus SHA" };
  }
  return { ok: true };
}
