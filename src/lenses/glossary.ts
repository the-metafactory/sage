import type { Finding, LensReport } from "./types.ts";

/**
 * CONTEXT.md glossary parsing + diff-aware excerpt/violation-detection
 * Module (compass#98 F7).
 *
 * Today the target-repo `CONTEXT.md` glossary is loaded (via
 * `architecture-docs.ts`) and fully rendered into stdin only for lenses
 * that opt in with `usesArchitectureDocs` (Architecture, ContextDrift).
 * The always-on CodeQuality lens — the one lens every review actually
 * runs — never sees it, so a PR that introduces a glossary `_Avoid_`
 * alias on a diff that doesn't otherwise trip Architecture/ContextDrift
 * applicability slips through glossary-blind.
 *
 * This module does two things, both deliberately narrower than the CC
 * skill's Architecture lens (`arc-skill-code-review` `skill/
 * ArchitectureDocs.md`), which does full public/internal/prose
 * symbol-scope classification via an LLM call:
 *
 *   1. `buildGlossaryContext` — a compact, diff-relevant excerpt (term +
 *      avoid list + citation, no full definitions) suitable for EVERY
 *      lens's stdin, not a 50KB CONTEXT.md dump.
 *   2. `findGlossaryViolations` — deterministic (no model call) exact
 *      `_Avoid_`-alias matches on ADDED diff lines. Severity `important`
 *      so a hit feeds `decideVerdict`'s changes-requested path the same
 *      way a model-authored finding would.
 *
 * The term/alias parser (`parseGlossary`, `extractAvoidAliases`) mirrors
 * the parsing contract in `arc-skill-code-review`'s `skill/
 * ArchitectureDocs.md` §2 so both carriers (the CC skill's Architecture
 * lens and this sage lens path) agree on what a "rule" and an "alias"
 * are, even though sage does not port §5's full symbol-scope severity
 * matrix.
 */

export interface GlossaryEntry {
  /** Canonical term — the bolded heading text, without the `**`/`:`. */
  readonly term: string;
  /** `_Avoid_:` aliases for this term. Empty when the entry declares none. */
  readonly avoid: readonly string[];
  /** Nearest preceding `#`..`######` heading text, or "" if none. */
  readonly section: string;
  /** 1-indexed line of the `**Term**:` heading inside the source doc. */
  readonly line: number;
}

export interface GlossaryContext {
  /** Rendered excerpt for lens stdin. "" when no entries are diff-relevant. */
  readonly excerpt: string;
  readonly hasEntries: boolean;
}

// `^\*\*([A-Z][A-Za-z0-9 -]+)\*\*:` per ArchitectureDocs.md §2 — case
// matters, only bolded title-case terms with a trailing colon count.
const TERM_HEADING_RE = /^\*\*([A-Z][A-Za-z0-9 -]+)\*\*:\s*(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// `_Avoid_:` may sit on the term's own line (after the definition) or on
// its own line — search anywhere in the line, not just at line start.
const AVOID_LINE_RE = /_Avoid_:\s*(.*)$/;

/**
 * Parse `**Term**:` / `_Avoid_:` glossary entries out of a CONTEXT.md (or
 * CONTEXT-MAP.md) doc body. Pure, synchronous, no I/O.
 */
export function parseGlossary(content: string): GlossaryEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: GlossaryEntry[] = [];
  let section = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = line.match(HEADING_RE);
    if (heading?.[2]) {
      section = heading[2].trim();
      continue;
    }

    const termMatch = line.match(TERM_HEADING_RE);
    if (!termMatch?.[1]) continue;

    const term = termMatch[1].trim();
    const termLine = i + 1; // 1-indexed
    let avoidRaw = termMatch[2] ? termMatch[2].match(AVOID_LINE_RE)?.[1] : undefined;

    // Scan forward for a same-block `_Avoid_:` line. Stop at the next
    // term/heading (a new entry started) or the first blank line (the
    // block ended) — the two shapes seen in practice (multi-line
    // definition, or definition inline on the term's own line) both
    // keep `_Avoid_:` inside the same unbroken block.
    let j = i + 1;
    if (avoidRaw === undefined) {
      for (; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (next.trim() === "") {
          j++;
          break;
        }
        if (TERM_HEADING_RE.test(next) || HEADING_RE.test(next)) break;
        const avoidMatch = next.match(AVOID_LINE_RE);
        if (avoidMatch) {
          avoidRaw = avoidMatch[1] ?? "";
          j++;
          break;
        }
      }
    }

    entries.push({
      term,
      avoid: avoidRaw ? extractAvoidAliases(avoidRaw) : [],
      section,
      line: termLine,
    });
    i = Math.max(i, j - 1);
  }

  return entries;
}

/**
 * `_Avoid_:` alias-list extraction. Implements the three-pattern parser
 * contract from `ArchitectureDocs.md` §2 ("a naive split(',') is
 * wrong"): strip parenthetical asides, truncate prose extensions at the
 * earliest sentence-start / em-dash-aside / terminal-period marker, then
 * split on comma.
 */
export function extractAvoidAliases(raw: string): string[] {
  // 1. Strip parenthetical asides (non-nested).
  let text = raw.replace(/\([^)]*\)/g, "");

  // 2. Truncate at the EARLIEST prose-extension marker.
  const cutPoints: number[] = [];
  const sentenceStart = text.match(/\.\s+(?=[A-Z])/);
  if (sentenceStart?.index !== undefined) cutPoints.push(sentenceStart.index);
  const emDashAside = text.match(/\s+—\s+(?=[a-z])/);
  if (emDashAside?.index !== undefined) cutPoints.push(emDashAside.index);
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(".")) cutPoints.push(trimmed.length - 1);
  if (cutPoints.length > 0) {
    text = text.slice(0, Math.min(...cutPoints));
  }

  // 3. Split on comma, trim, strip trailing punctuation/backticks. 4. Drop empties.
  return text
    .split(",")
    .map((s) => s.trim().replace(/^[`]+|[`.;]+$/g, "").trim())
    .filter((s) => s.length > 0);
}

const MAX_EXCERPT_ENTRIES = 12;
const MAX_EXCERPT_CHARS = 2_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Literal, case-insensitive, word-boundary-respecting containment check. */
function literallyAppears(needle: string, haystack: string): boolean {
  if (!needle) return false;
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`, "i");
  return pattern.test(haystack);
}

/**
 * Entries whose canonical term OR any `_Avoid_` alias literally appears
 * somewhere in the diff. Used only to size the stdin excerpt — never the
 * full glossary, never the full CONTEXT.md.
 */
export function selectDiffRelevantEntries(
  entries: readonly GlossaryEntry[],
  diff: string,
): GlossaryEntry[] {
  return entries.filter(
    (entry) =>
      literallyAppears(entry.term, diff) || entry.avoid.some((alias) => literallyAppears(alias, diff)),
  );
}

function renderGlossaryEntryLine(entry: GlossaryEntry): string {
  const avoidPart = entry.avoid.length > 0 ? ` (avoid: ${entry.avoid.join(", ")})` : "";
  const sectionPart = entry.section ? `CONTEXT.md §${entry.section}` : "CONTEXT.md";
  return `- \`${entry.term}\`${avoidPart} — ${sectionPart}:${entry.line}`;
}

/**
 * Build the compact "Glossary (diff-relevant)" stdin excerpt. Diff-aware
 * (only entries the diff actually references) and size-aware (hard caps
 * on entry count and rendered length) so this never approaches dumping
 * the full CONTEXT.md (tens of KB) into every lens call.
 */
export function buildGlossaryContext(
  entries: readonly GlossaryEntry[],
  diff: string,
): GlossaryContext {
  const relevant = selectDiffRelevantEntries(entries, diff).slice(0, MAX_EXCERPT_ENTRIES);
  if (relevant.length === 0) return { excerpt: "", hasEntries: false };

  const rendered = relevant.map(renderGlossaryEntryLine).join("\n");
  const capped =
    rendered.length > MAX_EXCERPT_CHARS
      ? `${rendered.slice(0, MAX_EXCERPT_CHARS)}\n[…glossary excerpt truncated]`
      : rendered;

  return {
    excerpt: `Glossary (diff-relevant) — CONTEXT.md canonical terms referenced by this diff:
${capped}

If the diff introduces one of the listed Avoid aliases, prefer the canonical term or explain why the alias is intentional here.`,
    hasEntries: true,
  };
}

interface DiffAddedLine {
  path: string;
  lineNumber: number;
  text: string;
}

/** Walk a unified diff, yielding every added (`+`) line with its file + new-revision line number. */
function parseAddedLines(diff: string): DiffAddedLine[] {
  const lines = diff.split("\n");
  const added: DiffAddedLine[] = [];
  let currentPath = "";
  let newLineNo = 0;

  for (const raw of lines) {
    if (raw.startsWith("+++ ")) {
      const m = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      currentPath = m?.[1] === undefined || m[1] === "/dev/null" ? "" : m[1];
      continue;
    }
    if (raw.startsWith("--- ")) continue;

    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) {
      newLineNo = parseInt(hunk[1], 10);
      continue;
    }

    if (raw.startsWith("+")) {
      added.push({ path: currentPath, lineNumber: newLineNo, text: raw.slice(1) });
      newLineNo++;
      continue;
    }
    if (raw.startsWith("-")) continue; // removed line — new-revision counter doesn't advance
    if (raw.startsWith(" ")) {
      newLineNo++;
    }
    // diff --git / index / mode lines etc — ignored, no counter effect.
  }

  return added;
}

/**
 * Deterministic (non-model) `_Avoid_`-alias violations on added diff
 * lines. Severity `important` — same rank as a model-authored finding —
 * so a hit blocks the merge gate via `decideVerdict` regardless of
 * whether any usesArchitectureDocs lens ran for this PR.
 */
export function findGlossaryViolations(
  entries: readonly GlossaryEntry[],
  diff: string,
): Finding[] {
  const addedLines = parseAddedLines(diff);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const { path, lineNumber, text } of addedLines) {
    for (const entry of entries) {
      for (const alias of entry.avoid) {
        if (!literallyAppears(alias, text)) continue;
        const key = `${path}:${lineNumber}:${entry.term}:${alias}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const citation = `CONTEXT.md${entry.section ? ` §${entry.section}` : ""} — canonical term \`${entry.term}\` (avoid: ${entry.avoid.join(", ")}) — source CONTEXT.md:${entry.line}`;
        findings.push({
          path,
          line: lineNumber,
          severity: "important",
          title: `Avoid alias "${alias}" — use "${entry.term}"`,
          rationale: `Added line uses \`${alias}\`, a CONTEXT.md _Avoid_ alias for canonical term \`${entry.term}\`. Use \`${entry.term}\` instead, or document why the alias is intentional here. ${citation}`,
        });
      }
    }
  }

  return findings;
}

/** Wrap deterministic glossary findings as a code-synthesized LensReport, byte-shaped like a model-authored one so it flows through decideVerdict/renderVerdict unchanged. */
export function buildGlossaryLensReport(findings: readonly Finding[]): LensReport {
  return {
    lens: "Glossary",
    summary: `${findings.length} CONTEXT.md Avoid-alias violation(s) found on added lines (deterministic check, no model call).`,
    findings: [...findings],
    durationMs: 0,
  };
}
