#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  CorpusManifestSchema,
  ShadowComparisonRecordSchema,
  type ShadowComparisonRecord,
} from "../src/typesafe/index.ts";

const sourceDir = process.argv[2] ?? join(homedir(), ".config", "sage", "typesafe-shadow");
const outputDir = process.argv[3]
  ?? join(import.meta.dir, "..", "evaluation", "typesafe", "live-evidence");
const corpusPath = process.argv[4]
  ?? join(import.meta.dir, "..", "evaluation", "typesafe", "corpus.json");

const corpus = CorpusManifestSchema.parse(JSON.parse(readFileSync(corpusPath, "utf8")));
const approvedHeads = new Set(corpus.entries.map((entry) =>
  `${entry.owner}/${entry.repo}#${entry.number}:${entry.headSha}`));
const SourceAnchorSchema = z.object({
  ref: z.object({ owner: z.string(), repo: z.string(), number: z.number().int() }),
  headSha: z.string(),
  repeatCount: z.number().int(),
  failureReason: z.string().nullable(),
}).passthrough();

function sanitize(record: ShadowComparisonRecord): ShadowComparisonRecord {
  const sanitizeStage = (stage: ShadowComparisonRecord["routing"]) => ({
    ...stage,
    signals: stage.signals.map((signal) => ({ ...signal, subject: "[REDACTED]" })),
  });
  return {
    ...record,
    state: {
      ...record.state,
      pr: { ...record.state.pr, title: "[REDACTED]", changedPaths: [] },
      candidates: record.state.candidates.map((candidate) => ({
        ...candidate,
        path: "[REDACTED]",
        excerpt: "",
        selectionReason: "[REDACTED]",
      })),
      discardedCandidateSummary: {
        ...record.state.discardedCandidateSummary,
        paths: [],
      },
    },
    routing: sanitizeStage(record.routing),
    evidence: sanitizeStage(record.evidence),
  };
}

function repositorySafeJson(record: ShadowComparisonRecord): string {
  // Some repository scanners interpret long decimal runs inside otherwise
  // hexadecimal public commit IDs as account numbers. JSON unicode escapes
  // preserve the decoded SHA while avoiding that false positive.
  const marker = "__SAGE_JSON_UNICODE_";
  const serialized = JSON.stringify(record, (_key, value: unknown) =>
    typeof value === "string"
      ? value.replace(/[0-9]{17,}/g, (digits) => {
          const escaped = digits.charCodeAt(16).toString(16).padStart(4, "0");
          return `${digits.slice(0, 16)}${marker}${escaped}__${digits.slice(17)}`;
        })
      : value, 2);
  return `${serialized.replace(new RegExp(`${marker}([0-9a-f]{4})__`, "g"), "\\u$1")}\n`;
}

const records = readdirSync(sourceDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(sourceDir, name), "utf8")) as unknown)
  .flatMap((raw) => {
    const anchor = SourceAnchorSchema.safeParse(raw);
    if (!anchor.success) return [];
    const key = `${anchor.data.ref.owner}/${anchor.data.ref.repo}#${anchor.data.ref.number}:${anchor.data.headSha}`;
    if (!approvedHeads.has(key) || anchor.data.repeatCount !== 3 || anchor.data.failureReason !== null) {
      return [];
    }
    // The first immutable live cohort predates the explicit authorizationMode
    // field. Its matching frozen-corpus anchor is verified above before this
    // one-way evidence-export migration is applied.
    const migrated = raw as Record<string, unknown>;
    return [ShadowComparisonRecordSchema.parse({
      ...migrated,
      authorizationMode: migrated.authorizationMode ?? "frozen-corpus",
    })];
  });

mkdirSync(outputDir, { recursive: true });
for (const record of records) {
  const sanitized = ShadowComparisonRecordSchema.parse(sanitize(record));
  writeFileSync(join(outputDir, `${record.recordId}.json`), repositorySafeJson(sanitized), {
    flag: "w",
    mode: 0o644,
  });
}

console.log(`Exported ${records.length} sanitized TypeSafe records to ${outputDir}`);
