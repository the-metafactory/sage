import { describe, expect, test } from "bun:test";
import {
  parseConcurrencyValue,
  readConcurrencyEnv,
  runLenses,
} from "../src/lenses/scheduler.ts";
import type { LensModule } from "../src/lenses/registry.ts";
import type { LensReport } from "../src/lenses/types.ts";
import type { Substrate } from "../src/substrate/types.ts";
import { TEXT_PIPELINE } from "../src/substrate/json/pipelines.ts";

/**
 * sage#59 Lens-run scheduling Module — invariants I1–I7.
 */

const stubSubstrate: Substrate = {
  name: "pi",
  displayName: "pi.dev",
  bin: "pi",
  jsonPipeline: TEXT_PIPELINE,
  envRequirements: { namespaces: [], keys: [] },
  run: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 }),
};

const stubPr = {
  number: 1,
  title: "t",
  body: "",
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefName: "f",
  author: { login: "a" },
  changedFiles: 1,
  additions: 1,
  deletions: 0,
  files: [{ path: "a.ts", additions: 1, deletions: 0 }],
  url: "https://github.com/x/y/pull/1",
};

function makeLens(
  name: string,
  impl: () => Promise<LensReport>,
  applies?: () => boolean,
): LensModule {
  return {
    name,
    review: impl,
    ...(applies !== undefined ? { applies } : {}),
  };
}

function ok(name: string, delayMs = 0): LensModule {
  return makeLens(name, async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return {
      lens: name,
      summary: "ok",
      findings: [],
      durationMs: delayMs,
    };
  });
}

function throwing(name: string, message: string): LensModule {
  return makeLens(name, async () => {
    throw new Error(message);
  });
}

const baseInput = {
  ctx: { pr: stubPr, diff: "diff" },
  substrate: stubSubstrate,
  priorFindings: [],
};

describe("runLenses — I1 result preserves registry order", () => {
  test("slow first lens still appears at index 0", async () => {
    const lenses = [ok("Slow", 30), ok("Fast", 1)];
    const reports = await runLenses({ lenses, ...baseInput });
    expect(reports.map((r) => r.lens)).toEqual(["Slow", "Fast"]);
  });

  test("skipped lenses (applies: false) absent from result", async () => {
    const lenses = [
      ok("A"),
      makeLens(
        "Skipped",
        async () => {
          throw new Error("should not run");
        },
        () => false,
      ),
      ok("B"),
    ];
    const reports = await runLenses({ lenses, ...baseInput });
    expect(reports.map((r) => r.lens)).toEqual(["A", "B"]);
  });
});

describe("runLenses — I2 onLensComplete fires in completion order", () => {
  test("fast lens completes before slow lens; callback order reflects completion", async () => {
    const lenses = [ok("Slow", 30), ok("Fast", 1)];
    const callbackOrder: string[] = [];
    const reports = await runLenses({
      lenses,
      ...baseInput,
      onLensComplete: (r) => {
        callbackOrder.push(r.lens);
      },
    });
    expect(callbackOrder).toEqual(["Fast", "Slow"]);
    expect(reports.map((r) => r.lens)).toEqual(["Slow", "Fast"]);
  });

  test("fires exactly once per applicable lens (no over-fire on errored)", async () => {
    const lenses = [ok("A"), throwing("B", "boom"), ok("C")];
    const callbackCalls: string[] = [];
    await runLenses({
      lenses,
      ...baseInput,
      onLensComplete: (r) => {
        callbackCalls.push(r.lens);
      },
    });
    expect(callbackCalls.sort()).toEqual(["A", "B", "C"]);
  });
});

describe("runLenses — I3 Lens throw synthesizes errored report", () => {
  test("errored: true, severity important, source runtime", async () => {
    const lenses = [throwing("Crashy", "kaboom")];
    const reports = await runLenses({ lenses, ...baseInput });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.errored).toBe(true);
    expect(reports[0]!.findings[0]!.severity).toBe("important");
    expect(reports[0]!.findings[0]!.rationale).toMatch(/kaboom/);
  });

  test("callback STILL fires for synthesized errored report", async () => {
    const lenses = [throwing("Crashy", "kaboom")];
    let fired = false;
    await runLenses({
      lenses,
      ...baseInput,
      onLensComplete: () => {
        fired = true;
      },
    });
    expect(fired).toBe(true);
  });
});

describe("runLenses — I4 callback throws are swallowed", () => {
  test("next callback still fires after a previous one throws", async () => {
    const lenses = [ok("A"), ok("B"), ok("C")];
    const calls: string[] = [];
    await runLenses({
      lenses,
      ...baseInput,
      onLensComplete: (r) => {
        calls.push(r.lens);
        if (r.lens === "A") throw new Error("callback boom");
      },
    });
    expect(calls.sort()).toEqual(["A", "B", "C"]);
  });

  test("report is still in the result array when callback throws", async () => {
    const lenses = [ok("A")];
    const reports = await runLenses({
      lenses,
      ...baseInput,
      onLensComplete: () => {
        throw new Error("callback boom");
      },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.lens).toBe("A");
  });
});

describe("runLenses — I5/I6 concurrency validation", () => {
  test("concurrency: 0 → synchronous throw before any lens runs", async () => {
    let ranAny = false;
    const lenses = [
      makeLens("A", async () => {
        ranAny = true;
        return {
          lens: "A",
          summary: "",
          findings: [],
          durationMs: 0,
        };
      }),
    ];
    await expect(
      runLenses({ lenses, ...baseInput, concurrency: 0 }),
    ).rejects.toThrow(/integer >= 1/);
    expect(ranAny).toBe(false);
  });

  test("concurrency: -1 → synchronous throw", async () => {
    const lenses = [ok("A")];
    await expect(
      runLenses({ lenses, ...baseInput, concurrency: -1 }),
    ).rejects.toThrow(/integer >= 1/);
  });

  test("concurrency: 1.5 → synchronous throw", async () => {
    const lenses = [ok("A")];
    await expect(
      runLenses({ lenses, ...baseInput, concurrency: 1.5 }),
    ).rejects.toThrow(/integer >= 1/);
  });

  test("concurrency: undefined uses unlimited parallelism (Promise.all path)", async () => {
    const lenses = [ok("A", 5), ok("B", 5), ok("C", 5)];
    const start = Date.now();
    await runLenses({ lenses, ...baseInput });
    const elapsed = Date.now() - start;
    // Sequential would take ~15ms; parallel should be ~5–10ms.
    expect(elapsed).toBeLessThan(40);
  });

  test("concurrency: 1 serializes execution", async () => {
    const inFlight = { count: 0, peak: 0 };
    const slow = (name: string): LensModule => ({
      name,
      review: async () => {
        inFlight.count++;
        if (inFlight.count > inFlight.peak) inFlight.peak = inFlight.count;
        await new Promise((r) => setTimeout(r, 10));
        inFlight.count--;
        return { lens: name, summary: "", findings: [], durationMs: 10 };
      },
    });
    await runLenses({
      lenses: [slow("A"), slow("B"), slow("C")],
      ...baseInput,
      concurrency: 1,
    });
    expect(inFlight.peak).toBe(1);
  });

  test("concurrency: 2 caps in-flight at 2", async () => {
    const inFlight = { count: 0, peak: 0 };
    const slow = (name: string): LensModule => ({
      name,
      review: async () => {
        inFlight.count++;
        if (inFlight.count > inFlight.peak) inFlight.peak = inFlight.count;
        await new Promise((r) => setTimeout(r, 10));
        inFlight.count--;
        return { lens: name, summary: "", findings: [], durationMs: 10 };
      },
    });
    await runLenses({
      lenses: [slow("A"), slow("B"), slow("C"), slow("D")],
      ...baseInput,
      concurrency: 2,
    });
    expect(inFlight.peak).toBe(2);
  });
});

describe("readConcurrencyEnv / parseConcurrencyValue", () => {
  test("undefined env returns undefined", () => {
    expect(readConcurrencyEnv("__SAGE_NEVER_SET__")).toBeUndefined();
  });

  test("parseConcurrencyValue rejects non-integers", () => {
    expect(() => parseConcurrencyValue("foo", "src")).toThrow();
    expect(() => parseConcurrencyValue("1.5", "src")).toThrow();
    expect(() => parseConcurrencyValue("-1", "src")).toThrow();
    expect(() => parseConcurrencyValue("0", "src")).toThrow();
  });

  test("parseConcurrencyValue returns numeric value for valid input", () => {
    expect(parseConcurrencyValue("3", "src")).toBe(3);
  });

  test("parseConcurrencyValue returns undefined for empty / whitespace", () => {
    expect(parseConcurrencyValue("", "src")).toBeUndefined();
    expect(parseConcurrencyValue("   ", "src")).toBeUndefined();
    expect(parseConcurrencyValue(undefined, "src")).toBeUndefined();
  });
});
