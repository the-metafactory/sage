#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  generateEvaluationReport,
  renderEvaluationReport,
  ReviewerLabelSchema,
  EvaluationThresholdsSchema,
  type ShadowComparisonRecord,
} from "../src/typesafe/index.ts";

const recordsDir = process.argv[2] ?? join(homedir(), ".config", "sage", "typesafe-shadow");
const labelsPath =
  process.argv[3] ?? join(import.meta.dir, "..", "evaluation", "typesafe", "reviewer-labels.json");
const thresholdsPath =
  process.argv[4] ?? join(import.meta.dir, "..", "evaluation", "typesafe", "thresholds.json");

const records = readdirSync(recordsDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(recordsDir, name), "utf8")) as ShadowComparisonRecord);
const rawLabels: unknown = JSON.parse(readFileSync(labelsPath, "utf8"));
if (!Array.isArray(rawLabels)) throw new Error("reviewer labels must be a JSON array");
const labels = rawLabels.map((label) => ReviewerLabelSchema.parse(label));
const thresholds = EvaluationThresholdsSchema.parse(
  JSON.parse(readFileSync(thresholdsPath, "utf8")),
);

console.log(renderEvaluationReport(generateEvaluationReport(records, labels, thresholds)));
