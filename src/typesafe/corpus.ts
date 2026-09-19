import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";

import type { PrRef } from "../forge/types.ts";

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

const RepositoryAuthorizationSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  classification: z.literal("non-critical-game"),
  approvedBy: z.string().min(1),
  approvedAt: z.string().datetime(),
});

export const CorpusManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorizationMode: z
      .enum(["frozen-corpus", "approved-repositories-until-revoked"])
      .optional(),
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
    repositories: z.array(RepositoryAuthorizationSchema).optional(),
  })
  .superRefine((manifest, ctx) => {
    if (
      manifest.dataProcessingApproval.status === "pending" &&
      (manifest.entries.length > 0 || (manifest.repositories?.length ?? 0) > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dataProcessingApproval"],
        message: "pending data-processing approval requires empty authorization scopes",
      });
    }
    const mode = manifest.authorizationMode ?? "frozen-corpus";
    if (
      manifest.dataProcessingApproval.status === "approved" &&
      mode === "frozen-corpus" &&
      manifest.frozenAt === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["frozenAt"],
        message: "an approved corpus must have a freeze timestamp",
      });
    }
    if (
      mode === "approved-repositories-until-revoked" &&
      (manifest.repositories?.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repositories"],
        message: "until-revoked mode requires at least one approved repository",
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
  const manifest = CorpusManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (manifest.authorizationMode === "approved-repositories-until-revoked") {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("until-revoked authorization manifest must not be a symbolic link");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("until-revoked authorization manifest must be owned by the current user");
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error("until-revoked authorization manifest must have mode 600");
    }
  }
  return manifest;
}

export interface CorpusAuthorizationInput {
  readonly ref: Readonly<PrRef>;
  readonly headSha: string;
}

export function authorizeCorpusInput(
  manifest: CorpusManifest,
  input: CorpusAuthorizationInput,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.dataProcessingApproval.status !== "approved") {
    return { ok: false, reason: "data-processing approval is pending" };
  }
  if (manifest.authorizationMode === "approved-repositories-until-revoked") {
    const repository = manifest.repositories?.find(
      (candidate) =>
        candidate.owner === input.ref.owner && candidate.repo === input.ref.repo,
    );
    if (!repository) {
      return { ok: false, reason: "repository is not in the until-revoked game allowlist" };
    }
    return { ok: true };
  }
  const entry = manifest.entries.find(
    (candidate) =>
      candidate.owner === input.ref.owner &&
      candidate.repo === input.ref.repo &&
      candidate.number === input.ref.number,
  );
  if (!entry) return { ok: false, reason: "PR is not present in the approved frozen corpus" };
  if (entry.headSha !== input.headSha) {
    return { ok: false, reason: "PR head does not match the approved immutable corpus SHA" };
  }
  return { ok: true };
}
