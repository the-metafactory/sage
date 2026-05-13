import { runLens, type LensRunInput } from "./base.ts";
import type { LensReport } from "./types.ts";

const FOCUS = `Look at this PR through a performance lens. You care about: hot-path latency
(work inside loops or tight intervals), unnecessary allocations (closures
in render paths, large object copies), database & network access patterns
(N+1 queries, sequential awaits where parallel would do, wildcard SELECTs),
sync I/O in async paths (readFileSync, execSync), and unbounded memory
growth (caches without eviction, queues without back-pressure). You do NOT
look for code style, correctness on the happy path, or architecture — those
belong to other lenses.

Flag a finding only when there is a concrete cost — a measured or clearly
inferable degradation, not "this could theoretically be slower".`;

export async function reviewPerformance(input: LensRunInput): Promise<LensReport> {
  return runLens({ name: "Performance", focus: FOCUS }, input);
}
