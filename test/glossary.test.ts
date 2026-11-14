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

describe("buildGlossaryLensReport", () => {
  test("wraps findings as a code-synthesized LensReport shaped like a model-authored one", () => {
    const findings = findGlossaryViolations(
      parseGlossary(FIXTURE_CONTEXT_MD),
      sourceDiff("src/bus.ts", "+export const sender = 1;"),
    );
    const report = buildGlossaryLensReport(findings);
    expect(report.lens).toBe("Glossary");
    expect(report.findings).toEqual(findings);
    expect(report.errored).toBeUndefined();
    expect(report.summary).toContain("1 CONTEXT.md Avoid-alias violation");
  });
});

function sourceDiff(path: string, body: string, start = 1): string {
  const lines = body.split("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${start},0 +${start},${lines.length} @@\n${lines.join("\n")}\n`;
}

describe("findGlossaryViolations — exported names only", () => {
  const entries = parseGlossary(FIXTURE_CONTEXT_MD);

  test("repro: plain words in Markdown prose and source comments are not findings", () => {
    expect(findGlossaryViolations(entries, sourceDiff("docs/bus.md", "+The sender hands a message to the handler."))).toEqual([]);
    expect(findGlossaryViolations(entries, sourceDiff("src/bus.ts", "+// The sender hands a message to the handler."))).toEqual([]);
  });

  test("flags an alias used as a word in an exported declaration name, as a non-gating nit", () => {
    const findings = findGlossaryViolations(entries, sourceDiff("src/bus.ts", " const x = 1;\n+export function resolveSender(): string {", 10));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "src/bus.ts", line: 11, severity: "nit", impact: "prose" });
    expect(findings[0]?.title).toBe('Avoid alias "sender" — use "Originator"');
    expect(findings[0]?.rationale).toContain("`resolveSender`");
    expect(findings[0]?.rationale).toContain("CONTEXT.md:20");
  });

  test("matches whole words inside camelCase, PascalCase and SCREAMING_SNAKE names", () => {
    const flagged = (line: string) => findGlossaryViolations(entries, sourceDiff("src/a.ts", `+${line}`)).map((f) => f.title);
    expect(flagged("export const dispatcherId = 1;")).toEqual(['Avoid alias "dispatcher" — use "Renderer"']);
    expect(flagged("export class MessagePacket {}")).toHaveLength(2);
    expect(flagged("export const DISPATCH_SOURCE = 1;")).toEqual(['Avoid alias "dispatch-source" — use "Originator"']);
    expect(flagged("export const botany = 1;")).toEqual([]);
    expect(flagged("export type Senders = string[];")).toEqual([]);
  });

  test("ignores local declarations, usages, re-exports and non-JS/TS files", () => {
    const body = [
      "+const sender = resolveOriginator();",
      "+function handler() {}",
      "+const detail = error.message;",
      '+import { sender } from "./sender.ts";',
      '+export { sender } from "./sender.ts";',
    ].join("\n");
    expect(findGlossaryViolations(entries, sourceDiff("src/a.ts", body))).toEqual([]);
    expect(findGlossaryViolations(entries, sourceDiff("README.md", "+export function sender() {}"))).toEqual([]);
    expect(findGlossaryViolations(entries, sourceDiff("tool.py", "+export function sender() {}"))).toEqual([]);
  });

  test("does NOT flag removed or context lines", () => {
    expect(findGlossaryViolations(entries, sourceDiff("src/a.ts", "-export const sender = 1;\n export const packet = 2;\n+export const ok = 3;"))).toEqual([]);
  });

  test("flags public members of an exported interface, class or enum opened in the hunk", () => {
    const body = [
      " export interface ExchangeLine {",
      "+  sender: string;",
      "+  readonly packet?: number;",
      "+  handler(): void;",
      " }",
      "+export class Bus {",
      "+  private gateway = 1;",
      "+  #plugin = 2;",
      "+  publish(): void {",
      "+    const connector = { executor: 1 };",
      "+  }",
      "+  static daemon = 3;",
      "+}",
    ].join("\n");
    const aliases = findGlossaryViolations(entries, sourceDiff("src/a.ts", body)).map((f) => f.title.split('"')[1]);
    expect(aliases).toEqual(["sender", "packet", "handler", "daemon"]);
  });

  test("a member line whose declaration is outside the hunk is not guessed at", () => {
    expect(findGlossaryViolations(entries, sourceDiff("src/a.ts", "   id: string;\n+  sender: string;", 40))).toEqual([]);
  });

  test("one finding per (file, alias), naming every canonical term and the other lines", () => {
    const body = "+export const botId = 1;\n+export const otherBot = 2;";
    const findings = findGlossaryViolations(entries, `${sourceDiff("src/a.ts", body)}${sourceDiff("src/b.ts", body)}`);
    expect(findings.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(findings[0]?.title).toBe('Avoid alias "bot" — use "Assistant" or "Agent"');
    expect(findings[0]?.rationale).toContain("Also on line 2.");
  });

  test("glossary-ignore in the same hunk exempts the alias; another hunk's marker does not", () => {
    const exempt = sourceDiff("src/a.ts", "+// glossary-ignore: Sender, packet\n+export const sender = 1;\n+export const packet = 2;\n+export const handler = 3;");
    expect(findGlossaryViolations(entries, exempt).map((f) => f.title.split('"')[1])).toEqual(["handler"]);
    const other = `${sourceDiff("src/a.ts", "+// glossary-ignore: sender")}@@ -40,0 +41,1 @@\n+export const sender = 1;\n`;
    expect(findGlossaryViolations(entries, other)).toHaveLength(1);
    expect(findGlossaryViolations(entries, other)[0]?.line).toBe(41);
  });
});
