import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * sage#26: lens execution is parallel, not sequential.
 *
 * The pre-#26 loop awaited each lens before starting the next, so a
 * single PR review paid the cold-start latency of every applicable lens
 * in series. Lenses share read-only `pr`/`diff` inputs and produce
 * disjoint `LensReport` outputs, so parallel execution is a pure
 * latency win — the per-lens work is unchanged.
 *
 * Pins behavioral guarantees:
 *   - applicable lenses run concurrently (peak in-flight > 1)
 *   - `lensReports` array is in registry order, regardless of which
 *     lens finished first
 *   - `onLensComplete` fires once per applicable lens
 *   - a lens that throws does NOT discard peer lens reports — a
 *     degraded report is synthesized in its slot
 */

/**
 * Fixture is shaped to trigger every applicability predicate so all six
 * lenses fire — that's the precondition for measuring parallelism. See
 * src/lenses/applicability.ts:
 *   - Security: "auth" in path
 *   - Architecture: new file directly under src/
 *   - EcosystemCompliance: arc-manifest.yaml in changeset
 *   - Performance: `setInterval(` in diff
 *   - Maintainability: .ts file with ≥20 lines changed
 * CodeQuality always fires.
 */
const stubPr = {
  number: 7,
  title: "test",
  baseRefName: "main",
  headRefName: "feat/y",
  author: { login: "alice" },
  body: "",
  changedFiles: 2,
  files: [
    { path: "src/auth.ts", additions: 25, deletions: 0 },
    { path: "arc-manifest.yaml", additions: 5, deletions: 0 },
  ],
};

const stubDiff = `diff --git a/src/auth.ts b/src/auth.ts
+setInterval(() => console.log('tick'), 1000);
+const token = 'xyz';
`;

interface SubstrateCall {
  systemPrompt?: string;
  prompt: string;
}

let inFlight = 0;
let peakInFlight = 0;
let substrateCalls: SubstrateCall[] = [];
let runJsonImpl: (opts: SubstrateCall) => Promise<{ summary: string; findings: never[] }>;

const stubSubstrate = {
  name: "pi" as const,
  displayName: "pi.dev",
  bin: "pi",
  run: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 }),
  // The lens layer (base.ts) calls runJson; we don't need run for these
  // tests. Track concurrency at this seam.
  runJson: async <T>(opts: SubstrateCall) => {
    substrateCalls.push({ systemPrompt: opts.systemPrompt, prompt: opts.prompt });
    inFlight++;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    try {
      const result = await runJsonImpl(opts);
      return {
        result: result as unknown as T,
        raw: { stdout: "", stderr: "", exitCode: 0, durationMs: 1 },
      };
    } finally {
      inFlight--;
    }
  },
};

beforeEach(() => {
  inFlight = 0;
  peakInFlight = 0;
  substrateCalls = [];
  runJsonImpl = async () => ({ summary: "ok", findings: [] });

  mock.module("../src/github/gh.ts", () => ({
    parsePrRef: (ref: string) => {
      const m = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
      if (!m) throw new Error(`bad ref ${ref}`);
      return { owner: m[1], repo: m[2], number: Number(m[3]) };
    },
    prView: async () => stubPr,
    prDiff: async () => stubDiff,
    postReview: async () => ({ posted: "comment" as const, downgraded: false }),
  }));

  mock.module("../src/util/persistence.ts", () => ({
    persistVerdict: () => true,
    verdictFilePath: (
      ref: { owner: string; repo: string; number: number },
      ext: string,
    ) => `/tmp/sage-test/${ref.owner}-${ref.repo}-${ref.number}.${ext}`,
    safeRefSegment: (v: string) => v.replace(/[^a-zA-Z0-9._-]/g, "_"),
  }));
});

afterEach(() => {
  mock.restore();
});

describe("reviewPr parallel lens execution (sage#26)", () => {
  test("applicable lenses run concurrently (peak in-flight > 1)", async () => {
    // Hold each lens open until they've all started. If lenses ran
    // serially this would deadlock; the harness times out instead of
    // silently passing. The barrier resolves only once all six lenses
    // are simultaneously inside runJson — that is the falsifiable test
    // for parallelism.
    //
    // NOTE on what `peakInFlight` measures (Holly #8): the counter
    // sits on the `runJson` seam, not on `lens.review`. Every lens
    // in-tree today goes through `runLens` → `substrate.runJson`, so
    // the two are 1:1. If a future lens skips the substrate (cached,
    // heuristic-only, deterministic-from-diff) this gauge would
    // undercount it. Re-pin against a `lens.review` spy if that
    // happens.
    const EXPECTED_LENSES = 6; // CodeQuality + 5 conditional, all apply for a .ts PR
    let barrierResolve!: () => void;
    const barrier = new Promise<void>((resolve) => {
      barrierResolve = resolve;
    });
    let arrivals = 0;

    runJsonImpl = async () => {
      arrivals++;
      if (arrivals === EXPECTED_LENSES) barrierResolve();
      await barrier;
      return { summary: "ok", findings: [] };
    };

    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 7 },
      substrate: stubSubstrate,
      post: false,
    });

    expect(peakInFlight).toBe(EXPECTED_LENSES);
    expect(substrateCalls.length).toBe(EXPECTED_LENSES);
    expect(result.verdict.lenses.length).toBe(EXPECTED_LENSES);
  });

  test("lensReports preserve registry order even when lenses finish out of order", async () => {
    // Stagger completion times so the last-declared lens finishes
    // first. Verdict.lenses must still be in registry-declared order so
    // the rendered review body and downstream consumers see a stable
    // shape. The lens registry order is the canonical reading order
    // (see src/lenses/registry.ts §canonical lens order).
    const registryOrder = [
      "CodeQuality",
      "Security",
      "Architecture",
      "EcosystemCompliance",
      "Performance",
      "Maintainability",
    ];
    runJsonImpl = async (opts) => {
      // Identify which lens is calling via its system prompt — each
      // lens injects its name into the prompt via base.ts COMMON_INSTRUCTION.
      const lensName = registryOrder.find((n) =>
        opts.systemPrompt?.includes(`running the ${n} lens`),
      );
      // Reverse the timing: last-declared completes first.
      const idx = registryOrder.indexOf(lensName ?? "");
      const delay = (registryOrder.length - idx) * 5;
      await new Promise((r) => setTimeout(r, delay));
      return { summary: `${lensName} ok`, findings: [] };
    };

    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 7 },
      substrate: stubSubstrate,
      post: false,
    });

    expect(result.verdict.lenses.map((l) => l.lens)).toEqual(registryOrder);
  });

  test("onLensComplete fires once per applicable lens", async () => {
    const fired: string[] = [];
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    await reviewPr({
      ref: { owner: "x", repo: "y", number: 7 },
      substrate: stubSubstrate,
      post: false,
      onLensComplete: (report) => {
        fired.push(report.lens);
      },
    });
    expect(fired.length).toBe(6);
    expect(new Set(fired)).toEqual(
      new Set([
        "CodeQuality",
        "Security",
        "Architecture",
        "EcosystemCompliance",
        "Performance",
        "Maintainability",
      ]),
    );
  });

  test("onLensComplete fires for errored lenses too (sage#27 Holly round 2 #2)", async () => {
    // Pre-fix the synthesis happened in a post-allSettled map, which
    // skipped the callback for rejected slots. The bridge's
    // dispatch.task.progress stream silently dropped the most
    // important event — a lens crashing. Round-2 fix: catch inline so
    // the callback fires uniformly.
    const realRegistry = await import("../src/lenses/registry.ts");
    const realLenses = realRegistry.LENSES;

    mock.module("../src/lenses/registry.ts", () => ({
      ...realRegistry,
      LENSES: realLenses.map((lens) =>
        lens.name === "Performance"
          ? {
              ...lens,
              review: async () => {
                throw new Error("performance lens crashed");
              },
            }
          : lens,
      ),
    }));

    const fired: { lens: string; errored?: boolean }[] = [];
    const { reviewPr } = await import("../src/lenses/workflow.ts");
    await reviewPr({
      ref: { owner: "x", repo: "y", number: 7 },
      substrate: stubSubstrate,
      post: false,
      onLensComplete: (report) => {
        fired.push({ lens: report.lens, errored: report.errored });
      },
    });

    // All six callbacks fired — clean lenses AND the crashed one.
    expect(fired.length).toBe(6);
    const perf = fired.find((f) => f.lens === "Performance");
    expect(perf).toBeDefined();
    expect(perf?.errored).toBe(true);
    // Peers fired without spurious errored flags.
    const security = fired.find((f) => f.lens === "Security");
    expect(security?.errored).toBeUndefined();
  });

  test("a lens runtime throw does NOT discard peer reports; errored slot synthesized", async () => {
    // `runLens` (base.ts) wraps substrate errors and returns a finding
    // fallback, so a lens normally cannot throw. This test pins the
    // defense-in-depth path: if a future lens implementation does
    // throw, peers' reports must survive AND the verdict must reflect
    // that one lens didn't actually run.
    //
    // Per Holly review of sage#27 (findings #1 + #2): the synthesized
    // slot carries `errored: true` and severity `important`, not the
    // pre-fix `nit`. A crashed lens blocks merge — its absence is the
    // signal.
    //
    // Force a throw by mocking the registry to inject a lens that
    // bypasses runLens entirely. The other five real lenses continue
    // to run normally through the stubbed substrate.
    const realRegistry = await import("../src/lenses/registry.ts");
    const realLenses = realRegistry.LENSES;

    mock.module("../src/lenses/registry.ts", () => ({
      ...realRegistry,
      LENSES: realLenses.map((lens) =>
        lens.name === "Security"
          ? {
              ...lens,
              review: async () => {
                throw new Error("simulated lens crash");
              },
            }
          : lens,
      ),
    }));

    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 7 },
      substrate: stubSubstrate,
      post: false,
    });

    // All six slots present, in registry order.
    expect(result.verdict.lenses.map((l) => l.lens)).toEqual([
      "CodeQuality",
      "Security",
      "Architecture",
      "EcosystemCompliance",
      "Performance",
      "Maintainability",
    ]);

    const security = result.verdict.lenses.find((l) => l.lens === "Security");
    expect(security?.errored).toBe(true);
    expect(security?.findings.length).toBe(1);
    expect(security?.findings[0].severity).toBe("important");
    expect(security?.findings[0].rationale).toMatch(/simulated lens crash/);
    // Peer lenses still produced clean reports without spurious `errored` flags.
    const codeQuality = result.verdict.lenses.find((l) => l.lens === "CodeQuality");
    expect(codeQuality?.findings.length).toBe(0);
    expect(codeQuality?.errored).toBeUndefined();

    // Verdict mechanically blocks merge — the `important` finding flips
    // the decision to changes-requested, AND the verdict summary names
    // the failed lens so the operator can see which coverage they lost.
    expect(result.verdict.decision).toBe("changes-requested");
    expect(result.verdict.summary).toMatch(/lens\(es\) failed to run: Security/);
  });

  test("multi-lens throw — each gets its own errored slot, peers stay clean", async () => {
    // Holly review of sage#27 (finding #7): a future reviewer who
    // refactors the synthesis into a shared error accumulator would
    // pass the single-throw test and silently regress this case. Pin
    // it now.
    const realRegistry = await import("../src/lenses/registry.ts");
    const realLenses = realRegistry.LENSES;
    const throwers = new Set(["Security", "Architecture", "Performance"]);

    mock.module("../src/lenses/registry.ts", () => ({
      ...realRegistry,
      LENSES: realLenses.map((lens) =>
        throwers.has(lens.name)
          ? {
              ...lens,
              review: async () => {
                throw new Error(`${lens.name} crashed`);
              },
            }
          : lens,
      ),
    }));

    const { reviewPr } = await import("../src/lenses/workflow.ts");
    const result = await reviewPr({
      ref: { owner: "x", repo: "y", number: 7 },
      substrate: stubSubstrate,
      post: false,
    });

    // Every thrower has its own errored slot referencing its own message.
    for (const name of throwers) {
      const slot = result.verdict.lenses.find((l) => l.lens === name);
      expect(slot?.errored).toBe(true);
      expect(slot?.findings[0]?.rationale).toMatch(new RegExp(`${name} crashed`));
    }

    // Peer lenses stayed clean.
    const peerNames = ["CodeQuality", "EcosystemCompliance", "Maintainability"];
    for (const name of peerNames) {
      const peer = result.verdict.lenses.find((l) => l.lens === name);
      expect(peer?.errored).toBeUndefined();
      expect(peer?.findings.length).toBe(0);
    }

    // Verdict summary names all three failures.
    expect(result.verdict.decision).toBe("changes-requested");
    expect(result.verdict.summary).toMatch(/Security/);
    expect(result.verdict.summary).toMatch(/Architecture/);
    expect(result.verdict.summary).toMatch(/Performance/);
  });
});
