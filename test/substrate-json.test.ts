import { describe, expect, test } from "bun:test";
import {
  CLAUDE_EXTRACTORS,
  TEXT_EXTRACTORS,
  extractFromRun,
  extractFromRunOrThrow,
} from "../src/substrate/json/index.ts";
// Extractor primitives are Module internals — deep-imported here so
// the public barrel stays tight (sage#63 round-4 Maintainability).
import {
  BALANCED_LARGEST,
  FENCED_LAST_FIRST,
  RAW,
  TRAILING,
} from "../src/substrate/json/extractors.ts";
import type { SubstrateRunResult } from "../src/substrate/types.ts";
import { isLensShaped, makeLensPipeline } from "../src/lenses/shape.ts";

/**
 * sage#57 introduced the Substrate JSON Module; sage#73 refined it
 * to make Pipeline a per-call composable and move `isLensShaped` to
 * the Lens side. Tests build their pipelines via `makeLensPipeline`
 * — the same construction site `lenses/base.ts` uses in production —
 * so they cannot drift on the composition shape.
 */

const TEXT_PIPELINE = makeLensPipeline(TEXT_EXTRACTORS);
const CLAUDE_PIPELINE = makeLensPipeline(CLAUDE_EXTRACTORS);

const ok = (stdout: string): SubstrateRunResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  durationMs: 1,
});

describe("isLensShaped", () => {
  test("accepts { summary, findings }", () => {
    expect(isLensShaped({ summary: "x", findings: [] })).toBe(true);
  });
  test("accepts { summary }", () => {
    expect(isLensShaped({ summary: "x" })).toBe(true);
  });
  test("accepts { findings }", () => {
    expect(isLensShaped({ findings: [] })).toBe(true);
  });
  test("rejects arrays, primitives, nulls", () => {
    expect(isLensShaped([])).toBe(false);
    expect(isLensShaped("string")).toBe(false);
    expect(isLensShaped(42)).toBe(false);
    expect(isLensShaped(null)).toBe(false);
    expect(isLensShaped(undefined)).toBe(false);
  });
  test("rejects non-lens objects", () => {
    expect(isLensShaped({ foo: "bar" })).toBe(false);
  });
});

describe("extractFromRun (TEXT_PIPELINE)", () => {
  test("RAW happy path: bare JSON parses on first attempt", () => {
    const out = extractFromRun(
      ok('{"summary":"ok","findings":[]}'),
      TEXT_PIPELINE,
      "pi",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.extractor).toBe("raw");
    expect(out.matchedPreferredShape).toBe(true);
    expect(out.result).toEqual({ summary: "ok", findings: [] });
  });

  test("FENCED_LAST_FIRST: last fenced block wins over earlier ones", () => {
    const stdout = [
      "Some preamble.",
      "```json",
      '{"foo":"first"}',
      "```",
      "More prose.",
      "```",
      '{"summary":"correct","findings":[]}',
      "```",
    ].join("\n");
    const out = extractFromRun(ok(stdout), TEXT_PIPELINE, "pi");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.extractor).toBe("fenced-last-first");
    expect(out.result).toEqual({ summary: "correct", findings: [] });
  });

  test("BALANCED_LARGEST: largest balanced span wins among inline objects", () => {
    const stdout =
      'Reasoning: see example {"foo":1}. The actual reply: {"summary":"big","findings":[{"path":"a","line":1,"severity":"nit","title":"t"}]}.';
    const out = extractFromRun(ok(stdout), TEXT_PIPELINE, "pi");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // BALANCED_LARGEST is the third extractor; RAW + FENCED return undefined.
    expect(out.extractor).toBe("balanced-largest");
    expect(out.matchedPreferredShape).toBe(true);
    expect((out.result as { summary: string }).summary).toBe("big");
  });

  test("TRAILING: prose-prefix + trailing JSON parses via trailing walk", () => {
    // Two top-level balanced objects so BALANCED_LARGEST picks the
    // larger one; here only one trailing object exists, so the
    // TRAILING extractor is the one that matches preferred shape.
    // Use a single-object trailing case to pin the TRAILING path.
    const stdout =
      "Some prose without any other balanced spans.\n" +
      '{"summary":"trailing","findings":[]}';
    const out = extractFromRun(ok(stdout), TEXT_PIPELINE, "pi");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toEqual({ summary: "trailing", findings: [] });
  });

  test("two-pass fallback: prefers lens shape over an earlier non-lens object", () => {
    // Two balanced objects — a smaller non-lens one first, then a
    // larger lens-shaped one later. The any-parseable first-pass
    // (RAW) would return the entire stdout but that's not valid JSON
    // here; balanced-largest picks the bigger lens object first
    // because it matches preferredShape.
    const stdout =
      '{"unrelated":42} ... and the reply: {"summary":"ok","findings":[]}';
    const out = extractFromRun(ok(stdout), TEXT_PIPELINE, "pi");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.matchedPreferredShape).toBe(true);
    expect((out.result as { summary: string }).summary).toBe("ok");
  });

  test("two-pass fallback: any-parseable wins when no lens shape exists", () => {
    const stdout = '{"unrelated":42}';
    const out = extractFromRun(ok(stdout), TEXT_PIPELINE, "pi");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.matchedPreferredShape).toBe(false);
    expect(out.result).toEqual({ unrelated: 42 });
  });

  test("exit-nonzero → failure with substrate label", () => {
    const out = extractFromRun(
      { stdout: "{}", stderr: "boom", exitCode: 2, durationMs: 1 },
      TEXT_PIPELINE,
      "pi",
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.substrate).toBe("pi");
    expect(out.failure.text).toBe("boom");
  });

  test("empty stdout → failure", () => {
    const out = extractFromRun(ok(""), TEXT_PIPELINE, "pi");
    expect(out.ok).toBe(false);
  });

  test("all extractors fail → failure carries attempt log", () => {
    const stdout = "no json here at all, just prose";
    const out = extractFromRun(ok(stdout), TEXT_PIPELINE, "pi");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // 4 extractors × pass-1 only (pass-2 short-circuits to undefined
    // for every extractor too) — failure carries one attempt per
    // extractor from the first pass.
    expect(out.failure.attempts.length).toBeGreaterThanOrEqual(4);
  });
});

describe("extractFromRun (CLAUDE_PIPELINE)", () => {
  test("CLAUDE_ENVELOPE: envelope.result inner JSON parses as lens body", () => {
    const envelope = {
      result: JSON.stringify({ summary: "ok", findings: [] }),
      type: "result",
    };
    const out = extractFromRun(ok(JSON.stringify(envelope)), CLAUDE_PIPELINE, "claude");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.extractor).toBe("claude-envelope");
    expect(out.result).toEqual({ summary: "ok", findings: [] });
  });

  test("CLAUDE_ENVELOPE: bare lens-shaped envelope passes through", () => {
    const envelope = { summary: "bare", findings: [] };
    const out = extractFromRun(ok(JSON.stringify(envelope)), CLAUDE_PIPELINE, "claude");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.extractor).toBe("claude-envelope");
  });

  test("CLAUDE_ENVELOPE: legacy .response field also works", () => {
    const envelope = {
      response: JSON.stringify({ summary: "legacy", findings: [] }),
    };
    const out = extractFromRun(ok(JSON.stringify(envelope)), CLAUDE_PIPELINE, "claude");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.result as { summary: string }).summary).toBe("legacy");
  });

  test("falls through to text extraction when no envelope at all", () => {
    const stdout = '{"summary":"plain","findings":[]}';
    const out = extractFromRun(ok(stdout), CLAUDE_PIPELINE, "claude");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // CLAUDE_ENVELOPE returns the parsed envelope which IS the lens
    // body, so it matches preferredShape directly.
    expect(["claude-envelope", "raw"]).toContain(out.extractor);
  });

  test("CLAUDE_ENVELOPE: fenced inner string still extracts lens body (sage#57→#63 blocker)", () => {
    // Reproduces the regression Sage flagged on PR #63: when the
    // assistant wraps its reply in a ```json … ``` fence inside the
    // envelope's `.result` string, the inner 4-tier strategies must
    // run against the *inner* string. The outer envelope encodes
    // newlines as `\n` literals, so fence regex / balanced-walk on
    // the outer text would never see the fence.
    const innerBody = '```json\n{"summary":"fenced","findings":[]}\n```';
    const envelope = { result: innerBody };
    const out = extractFromRun(
      ok(JSON.stringify(envelope)),
      CLAUDE_PIPELINE,
      "claude",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.extractor).toBe("claude-envelope");
    expect(out.result).toEqual({ summary: "fenced", findings: [] });
  });

  test("CLAUDE_ENVELOPE: prose-wrapped inner with trailing JSON still extracts", () => {
    const innerBody =
      "Here is my review:\n" +
      'I found one issue.\n' +
      '{"summary":"trailing","findings":[]}';
    const envelope = { result: innerBody };
    const out = extractFromRun(
      ok(JSON.stringify(envelope)),
      CLAUDE_PIPELINE,
      "claude",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.result as { summary: string }).summary).toBe("trailing");
  });
});

describe("extractFromRunOrThrow", () => {
  test("returns { result, extractor } on success", () => {
    const out = extractFromRunOrThrow<{ summary: string }>(
      ok('{"summary":"ok"}'),
      TEXT_PIPELINE,
      "pi",
    );
    expect(out.extractor).toBe("raw");
    expect(out.result.summary).toBe("ok");
  });

  test("throws on failure with attempt log + substrate label", () => {
    expect(() =>
      extractFromRunOrThrow(ok("no json"), TEXT_PIPELINE, "pi"),
    ).toThrow(/pi JSON extraction failed/);
  });
});

describe("Extractor primitives in isolation", () => {
  test("RAW returns undefined on empty input", () => {
    expect(RAW.extract("")).toBeUndefined();
  });
  test("RAW returns undefined on malformed JSON", () => {
    expect(RAW.extract("not json")).toBeUndefined();
  });
  test("FENCED_LAST_FIRST returns undefined when no fenced blocks", () => {
    expect(FENCED_LAST_FIRST.extract("no fences here")).toBeUndefined();
  });
  test("BALANCED_LARGEST returns undefined when no balanced objects", () => {
    expect(BALANCED_LARGEST.extract("no braces here")).toBeUndefined();
  });
  test("TRAILING returns undefined when no trailing `}`", () => {
    expect(TRAILING.extract("text without closing brace")).toBeUndefined();
  });
});
