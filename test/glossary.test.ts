import { describe, expect, test } from "bun:test";
import {
  buildGlossaryContext,
  buildGlossaryLensReport,
  extractAvoidAliases,
  findGlossaryViolations,
  parseGlossary,
  selectDiffRelevantEntries,
} from "../src/lenses/glossary.ts";

/**
 * compass#98 F7 — diff-aware CONTEXT.md glossary excerpt on the
 * always-on lens path. Fixture below mirrors arc-skill-code-review's
 * `fixtures/architecture-context/CONTEXT.md` (the canonical parser
 * fixture — its README asserts the parser should yield 6 rules from it).
 */
const FIXTURE_CONTEXT_MD = `# Sample Repo — Context

Test fixture for the Architecture lens. Models the cortex CONTEXT.md shape so the
lens' regex-based glossary parser can be exercised against a stable input.

## Language

### Assistants & agents

**Assistant**:
The named being the bot runs — Luna, Echo, Forge, Pilot. Has a persona and continuity of identity.
_Avoid_: persona, bot, DA, character

**Agent**:
The stack-local, long-lived runtime identity (daemon) that hosts an assistant on the bus.
_Avoid_: bot, persona, daemon

### The bus

**Originator**:
The identity that produced an envelope — populated by the adapter when a dispatch enters the bus.
_Avoid_: dispatch-source, sender, publisher

**Envelope**:
The signed wrapper that travels on a subject — metadata around a payload. Every bus message is an envelope.
_Avoid_: message, packet

### Surfaces

**Adapter**:
A platform-specific entry point (Discord, Mattermost) that translates external events into envelopes and resolves identities before publishing onto the bus. Resolution belongs at the adapter, not at the listener.
_Avoid_: connector, gateway, plugin

**Renderer**:
A read-only presentation component — turns envelopes into display output for humans. Renderers display; they MUST NOT execute side effects, mutate state, or perform identity resolution.
_Avoid_: executor, dispatcher, handler
`;

describe("parseGlossary", () => {
  test("yields one rule per **Term**: heading, with section + avoid list + line", () => {
    const entries = parseGlossary(FIXTURE_CONTEXT_MD);
    expect(entries).toHaveLength(6);

    const originator = entries.find((e) => e.term === "Originator");
    expect(originator).toEqual({
      term: "Originator",
      avoid: ["dispatch-source", "sender", "publisher"],
      section: "The bus",
      line: 20,
    });

    const adapter = entries.find((e) => e.term === "Adapter");
    expect(adapter?.avoid).toEqual(["connector", "gateway", "plugin"]);
    expect(adapter?.section).toBe("Surfaces");
  });

  test("handles an inline definition on the term's own line (sage stdin-test shape)", () => {
    const entries = parseGlossary("**Originator**: canonical source\n_Avoid_: sender");
    expect(entries).toEqual([{ term: "Originator", avoid: ["sender"], section: "", line: 1 }]);
  });

  test("entries without an _Avoid_: line still parse, with an empty avoid list", () => {
    const entries = parseGlossary("**Term**:\nNo avoid list here.\n");
    expect(entries).toEqual([{ term: "Term", avoid: [], section: "", line: 1 }]);
  });

  test("ignores non-title-case or unclosed bold spans", () => {
    const entries = parseGlossary("**lowercase**: nope\n**Unclosed: nope either\n");
    expect(entries).toEqual([]);
  });
});

describe("extractAvoidAliases — ArchitectureDocs.md §2 worked examples", () => {
  test("strips a parenthetical clarification embedded in the alias list", () => {
    expect(
      extractAvoidAliases("federation (that is the relationship, not the thing), mesh, fabric, org, cluster"),
    ).toEqual(["federation", "mesh", "fabric", "org", "cluster"]);
  });

  test("truncates at a prose extension following a terminal sentence", () => {
    expect(
      extractAvoidAliases(
        "deployment, instance, node. Never use `stack` for the M1–M7 architecture — that is the **Myelin layer model**.",
      ),
    ).toEqual(["deployment", "instance", "node"]);
  });

  test("strips a trailing parenthetical on the last alias", () => {
    expect(extractAvoidAliases("bot, persona, daemon (as the domain term)")).toEqual([
      "bot",
      "persona",
      "daemon",
    ]);
  });

  test("truncates at an em-dash aside", () => {
    expect(
      extractAvoidAliases(
        "channel, category — and never use `domain` for the DDD bounded-context sense (that is always written **bounded context**).",
      ),
    ).toEqual(["channel", "category"]);
  });

  test("simple comma list with no parens or prose passes through untouched", () => {
    expect(extractAvoidAliases("operator, user, owner, human, org")).toEqual([
      "operator",
      "user",
      "owner",
      "human",
      "org",
    ]);
  });
});

describe("selectDiffRelevantEntries / buildGlossaryContext", () => {
  const entries = parseGlossary(FIXTURE_CONTEXT_MD);

  test("selects only entries whose term or an alias literally appears in the diff", () => {
    const diff = "diff --git a/src/bus.ts b/src/bus.ts\n+export const sender = resolve();\n";
    const relevant = selectDiffRelevantEntries(entries, diff);
    expect(relevant.map((e) => e.term)).toEqual(["Originator"]);
  });

  test("buildGlossaryContext renders a compact excerpt, not the full glossary", () => {
    const diff = "+const persona = loadPersona();\n";
    const ctx = buildGlossaryContext(entries, diff);
    expect(ctx.hasEntries).toBe(true);
    expect(ctx.excerpt).toContain("Glossary (diff-relevant)");
    expect(ctx.excerpt).toContain("`Assistant`");
    expect(ctx.excerpt).toContain("`Agent`"); // "persona" is also an Agent alias
    // Unrelated terms must not be pulled in.
    expect(ctx.excerpt).not.toContain("`Renderer`");
    expect(ctx.excerpt).not.toContain("`Envelope`");
  });

  test("hasEntries is false and excerpt is empty when nothing in the diff matches", () => {
    const ctx = buildGlossaryContext(entries, "+const totallyUnrelated = 1;\n");
    expect(ctx).toEqual({ excerpt: "", hasEntries: false });
  });

  test("never dumps the full CONTEXT.md — excerpt stays far smaller than the source doc", () => {
    const diff = FIXTURE_CONTEXT_MD.split("\n")
      .map((l) => `+${l}`)
      .join("\n"); // pathological: diff contains every term + alias
    const ctx = buildGlossaryContext(entries, diff);
    expect(ctx.excerpt.length).toBeLessThan(FIXTURE_CONTEXT_MD.length);
  });
});

describe("findGlossaryViolations — deterministic, added-lines only", () => {
  const entries = parseGlossary(FIXTURE_CONTEXT_MD);

  test("flags an exact _Avoid_ alias on an added line as an important finding", () => {
    const diff = `diff --git a/src/bus.ts b/src/bus.ts
--- a/src/bus.ts
+++ b/src/bus.ts
@@ -10,2 +10,3 @@
 const x = 1;
+const sender = resolveOriginator();
 const y = 2;
`;
    const findings = findGlossaryViolations(entries, diff);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: "src/bus.ts",
      line: 11,
      severity: "important",
    });
    expect(findings[0]?.title).toContain("sender");
    expect(findings[0]?.rationale).toContain("Originator");
    expect(findings[0]?.rationale).toContain("CONTEXT.md:20");
  });

  test("does NOT flag removed or context lines — added lines only", () => {
    const diff = `diff --git a/src/bus.ts b/src/bus.ts
--- a/src/bus.ts
+++ b/src/bus.ts
@@ -1,3 +1,2 @@
-const sender = resolveOriginator();
 const packet = envelope;
+const ok = 1;
`;
    expect(findGlossaryViolations(entries, diff)).toEqual([]);
  });

  test("no violations when the diff doesn't reference any avoid alias", () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`;
    expect(findGlossaryViolations(entries, diff)).toEqual([]);
  });

  test("does not reinterpret a standard property identifier as domain prose", () => {
    const diff = `diff --git a/src/errors.ts b/src/errors.ts
--- a/src/errors.ts
+++ b/src/errors.ts
@@ -1,1 +1,2 @@
 const error = new Error();
+const detail = error.message;
`;
    expect(findGlossaryViolations(entries, diff)).toEqual([]);
  });

  test("computes correct new-revision line numbers across multiple hunks", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-const old = 1;
+const bot = 1;
@@ -20,1 +20,2 @@
 const kept = 1;
+const gateway = 2;
`;
    const findings = findGlossaryViolations(entries, diff);
    const byLine = Object.fromEntries(findings.map((f) => [f.line, f.title]));
    expect(byLine[1]).toContain("bot");
    expect(byLine[21]).toContain("gateway");
  });
});

// The fixtures below use Avoid aliases on purpose, so this hunk opts out
// of Sage's own glossary check. Fixture markers are built from IGNORE so
// they never follow a `//` opener in this file and exempt it by accident.
// glossary-ignore: sender, bot, persona, gateway, spawn
const IGNORE = ["glossary", "ignore:"].join("-");

/** Build a single-file, single-hunk diff whose hunk starts at `start` and whose lines are given with their `+`/` `/`-` prefix. */
function hunkDiff(path: string, start: number, lines: readonly string[]): string {
  return `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -${start},${lines.length} +${start},${lines.length} @@
${lines.join("\n")}
`;
}

/** The sage#128 repro: `Spawn` is an avoid-alias of two canonical terms. */
const SEELITE_CONTEXT_MD = `## Language

**Traffic actor**:
A moving NPC on the road network.
_Avoid_: Spawn, mob

**Encounter**:
A scripted meeting between the player and an actor.
_Avoid_: Spawn, event
`;

describe("findGlossaryViolations — sage#128 code awareness, dedupe, exemption", () => {
  const seelite = parseGlossary(SEELITE_CONTEXT_MD);
  const fixture = parseGlossary(FIXTURE_CONTEXT_MD);

  test("repro: Node import quoted in a Markdown fenced block yields no findings", () => {
    const diff = hunkDiff("docs/findings.md", 1, [
      "+## Appendix — driver",
      "+",
      "+```ts",
      '+import { spawn } from "node:child_process";',
      "+const child = spawn(process.execPath, [script]);",
      "+```",
    ]);
    expect(findGlossaryViolations(seelite, diff)).toEqual([]);
  });

  test("~~~ fences are skipped too", () => {
    const diff = hunkDiff("docs/a.md", 1, ["+~~~", "+spawn(cmd);", "+~~~"]);
    expect(findGlossaryViolations(seelite, diff)).toEqual([]);
  });

  test("fences in CRLF Markdown are recognised", () => {
    const diff = hunkDiff("docs/a.md", 1, ["+```ts\r", "+spawn(cmd);\r", "+```\r", "+Each Spawn waits.\r"]);
    expect(findGlossaryViolations(seelite, diff).map((f) => f.line)).toEqual([4]);
  });

  test("fence opener on a context line still marks added lines as code", () => {
    const diff = hunkDiff("docs/a.md", 40, [" ```js", "+spawn(cmd);", " ```"]);
    expect(findGlossaryViolations(seelite, diff)).toEqual([]);
  });

  test("prose after the closing fence is still flagged", () => {
    const diff = hunkDiff("docs/a.md", 1, ["+```ts", "+spawn(cmd);", "+```", "+Each Spawn waits."]);
    const findings = findGlossaryViolations(seelite, diff);
    expect(findings.map((f) => f.line)).toEqual([4]);
  });

  test("a bare fence in a mid-file hunk is ambiguous — lean toward flagging", () => {
    // Hunk starts at line 50: the bare ``` may close a fence opened above
    // the hunk, so the prose after it must not be silently skipped.
    const diff = hunkDiff("docs/a.md", 50, [" ```", "+Each Spawn waits.", " ```"]);
    expect(findGlossaryViolations(seelite, diff).map((f) => f.line)).toEqual([51]);
  });

  test("a mid-file hunk misreading an outer ```` closer still flags the prose after it", () => {
    // Lines 50-53 close a ```ts example inside a ```` block opened above
    // the hunk; the bare ```` is the outer closer, not an opener.
    const diff = hunkDiff("docs/a.md", 50, [" ```ts", " spawn(cmd);", " ```", " ````", "+Each Spawn waits."]);
    expect(findGlossaryViolations(seelite, diff).map((f) => f.line)).toEqual([54]);
  });

  test("an unclosed fence in a mid-file hunk is not trusted — lean toward flagging", () => {
    const diff = hunkDiff("docs/a.md", 50, [" ```ts", "+spawn(cmd);"]);
    expect(findGlossaryViolations(seelite, diff).map((f) => f.line)).toEqual([51]);
  });

  test("an unclosed fence in one file does not swallow the next file", () => {
    const diff =
      hunkDiff("docs/a.md", 1, ["+```ts", "+spawn(cmd);"]) +
      hunkDiff("docs/b.md", 1, ["+Each Spawn waits."]);
    const findings = findGlossaryViolations(seelite, diff);
    expect(findings.map((f) => `${f.path}:${f.line}`)).toEqual(["docs/b.md:1"]);
  });

  test("``` inside a non-Markdown file is not treated as a fence", () => {
    const diff = hunkDiff("src/a.ts", 1, ["+// ```", "+const sender = 1;", "+// ```"]);
    expect(findGlossaryViolations(fixture, diff).map((f) => f.line)).toEqual([2]);
  });

  test("Markdown inline code spans are skipped, prose on the same line is not", () => {
    const quoted = hunkDiff("docs/a.md", 1, ["+Uses `spawn` to fork."]);
    expect(findGlossaryViolations(seelite, quoted)).toEqual([]);

    const mixed = hunkDiff("docs/a.md", 1, ["+Uses `spawn` for each Spawn."]);
    expect(findGlossaryViolations(seelite, mixed)).toHaveLength(1);
  });

  test("one finding per (line, alias), naming every canonical term", () => {
    const diff = hunkDiff("docs/a.md", 1, ["+Each Spawn waits."]);
    const findings = findGlossaryViolations(seelite, diff);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('Avoid alias "Spawn" — use "Traffic actor" or "Encounter"');
    expect(findings[0]?.rationale).toContain("`Traffic actor`, `Encounter`");
    expect(findings[0]?.rationale).toContain("CONTEXT.md:3");
    expect(findings[0]?.rationale).toContain("CONTEXT.md:7");
  });

  test("single-term title is unchanged from the pre-#128 format", () => {
    const diff = hunkDiff("src/bus.ts", 1, ["+const sender = 1;"]);
    expect(findGlossaryViolations(fixture, diff)[0]?.title).toBe('Avoid alias "sender" — use "Originator"');
  });

  test("rationale names the exemption marker for the file type", () => {
    const md = findGlossaryViolations(seelite, hunkDiff("docs/a.md", 1, ["+Each Spawn waits."]));
    expect(md[0]?.rationale).toContain("<!-- glossary-ignore: Spawn -->");
    const ts = findGlossaryViolations(fixture, hunkDiff("src/a.ts", 1, ["+const sender = 1;"]));
    expect(ts[0]?.rationale).toContain("`// glossary-ignore: sender` (or `# …`) marker");
  });

  test("glossary-ignore on the same line exempts the alias (marker text itself is not flagged)", () => {
    const diff = hunkDiff("src/a.ts", 1, [`+const child = spawn(cmd); // ${IGNORE} spawn`]);
    expect(findGlossaryViolations(seelite, diff)).toEqual([]);
  });

  test("glossary-ignore anywhere in the hunk — added, context, before or after — exempts it", () => {
    const before = hunkDiff("docs/a.md", 10, [` <!-- ${IGNORE} Spawn -->`, "+Each Spawn waits."]);
    expect(findGlossaryViolations(seelite, before)).toEqual([]);

    const after = hunkDiff("docs/a.md", 10, ["+Each Spawn waits.", `+<!-- ${IGNORE} spawn -->`]);
    expect(findGlossaryViolations(seelite, after)).toEqual([]);
  });

  test("glossary-ignore takes a comma list and is case-insensitive", () => {
    const diff = hunkDiff("src/a.ts", 1, [`+// ${IGNORE} SENDER, Bot`, "+const sender = bot;"]);
    expect(findGlossaryViolations(fixture, diff)).toEqual([]);
  });

  test("glossary-ignore for one alias does not exempt another", () => {
    const diff = hunkDiff("src/a.ts", 1, [`+// ${IGNORE} sender`, "+const sender = bot;"]);
    const findings = findGlossaryViolations(fixture, diff);
    expect(findings.map((f) => f.title)).toEqual(['Avoid alias "bot" — use "Assistant" or "Agent"']);
  });

  test("glossary-ignore on a removed line does not count", () => {
    const diff = hunkDiff("src/a.ts", 1, [`-// ${IGNORE} sender`, "+const sender = 1;"]);
    expect(findGlossaryViolations(fixture, diff)).toHaveLength(1);
  });

  test("glossary-ignore inside a string literal does not exempt anything", () => {
    const diff = hunkDiff("src/a.ts", 1, [`+const s = "${IGNORE} sender";`, "+const sender = 1;"]);
    expect(findGlossaryViolations(fixture, diff).map((f) => f.line)).toEqual([1, 2]);
  });

  test("glossary-ignore after # works (Python, YAML, shell)", () => {
    const diff = hunkDiff("tools/a.py", 1, [`+sender = resolve()  # ${IGNORE} sender`]);
    expect(findGlossaryViolations(fixture, diff)).toEqual([]);
  });

  test("glossary-ignore inside a Markdown fenced block is quoted code and does not count", () => {
    const diff = hunkDiff("docs/a.md", 1, ["+```html", `+<!-- ${IGNORE} Spawn -->`, "+```", "+Each Spawn waits."]);
    expect(findGlossaryViolations(seelite, diff).map((f) => f.line)).toEqual([4]);
  });

  test("glossary-ignore in another hunk does not apply", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
+// ${IGNORE} sender
@@ -40,1 +40,1 @@
+const sender = 1;
`;
    expect(findGlossaryViolations(fixture, diff).map((f) => f.line)).toEqual([40]);
  });
});

describe("buildGlossaryLensReport", () => {
  test("wraps findings as a code-synthesized LensReport shaped like a model-authored one", () => {
    const findings = findGlossaryViolations(
      parseGlossary(FIXTURE_CONTEXT_MD),
      "+const sender = 1;\n",
    );
    const report = buildGlossaryLensReport(findings);
    expect(report.lens).toBe("Glossary");
    expect(report.findings).toEqual(findings);
    expect(report.errored).toBeUndefined();
    expect(report.summary).toContain("1 CONTEXT.md Avoid-alias violation");
  });
});
