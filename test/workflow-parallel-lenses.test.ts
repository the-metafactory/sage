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

  test("a lens runtime throw does NOT discard peer reports; degraded slot synthesized", async () => {
    // `runLens` (base.ts) wraps substrate errors and returns a
    // nit-finding fallback, so a lens normally cannot throw. This test
    // pins the defense-in-depth path: if a future lens implementation
    // does throw, peers' reports must survive.
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
    expect(security?.findings.length).toBe(1);
    expect(security?.findings[0].severity).toBe("nit");
    expect(security?.findings[0].rationale).toMatch(/simulated lens crash/);
    // Peer lenses still produced clean reports.
    const codeQuality = result.verdict.lenses.find((l) => l.lens === "CodeQuality");
    expect(codeQuality?.findings.length).toBe(0);
  });
});
