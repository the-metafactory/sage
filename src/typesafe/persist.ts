import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { safeRefSegment } from "../util/persistence.ts";
import type { ShadowComparisonRecord, ShadowRecordSink } from "./types.ts";

export function createFileShadowSink(
  root = join(homedir(), ".config", "sage", "typesafe-shadow"),
): ShadowRecordSink {
  return {
    write(record: ShadowComparisonRecord): string {
      mkdirSync(root, { recursive: true });
      const timestamp = record.createdAt.replace(/[:.]/g, "-");
      const slug = [
        safeRefSegment(record.ref.owner),
        safeRefSegment(record.ref.repo),
        record.ref.number,
        record.headSha.slice(0, 12) || "no-head",
        `repeat-${record.repeatIndex}`,
        safeRefSegment(record.recordId).slice(0, 16),
        timestamp,
      ].join("-");
      const path = join(root, `${slug}.json`);
      writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
      return path;
    },
  };
}
