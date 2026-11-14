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
 *   2. `findGlossaryViolations` — deterministic (no model call)
 *      `_Avoid_`-alias matches on added lines: in Markdown prose, in
 *      standalone source comments, and in the exported names JS/TS
 *      files declare. Severity `nit`, so a hit never blocks. Markdown
 *      code (fenced blocks, inline spans) is skipped, and a
 *      `glossary-ignore: <alias>` marker in the hunk exempts an
 *      intentional alias (sage#128).
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

/** A half-open `[start, end)` range of characters in a line, or of words in a name. */
type Span = readonly [start: number, end: number];

function isInside(inner: Span, outer: Span): boolean {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}

/** Where `needle` literally appears in `haystack`: case-insensitive, whole word, never an identifier property. */
function literalSpans(needle: string, haystack: string): Span[] {
  if (!needle) return [];
  const pattern = new RegExp(`(?<![A-Za-z0-9_.])${escapeRegExp(needle)}(?![A-Za-z0-9_])`, "gi");
  return [...haystack.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length] as const);
}

function literallyAppears(needle: string, haystack: string): boolean {
  return literalSpans(needle, haystack).length > 0;
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

If the diff introduces one of the listed Avoid aliases, prefer the canonical term. If the alias is intentional (e.g. a library function name), add ${markerSyntax("<alias>", false)} on that line or in the same hunk (${markerSyntax("<alias>", true)} in Markdown).`,
    hasEntries: true,
  };
}

interface DiffHunk {
  path: string;
  /** New-revision line number of the hunk's first line. */
  start: number;
  /** Added and context lines in order — the hunk's view of the new revision. */
  lines: { added: boolean; lineNumber: number; text: string }[];
}

/** One place an added line could use an alias: Markdown prose, a source comment, or an exported name a source line declares. */
interface Candidate {
  path: string;
  lineNumber: number;
  /** The exported name, for a source declaration; absent for prose and comments. */
  name?: string;
  uses: (alias: string) => boolean;
  /** Lower-cased aliases exempted by a `glossary-ignore:` marker in this line's hunk. */
  ignored: ReadonlySet<string>;
}

const MARKDOWN_PATH_RE = /\.(?:md|mdx|markdown)$/i;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*\s|#(?:\s|$)|--\s)(.*)$/;
// CommonMark fence: up to 3 spaces of indent, then 3+ backticks or tildes.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SOURCE_PATH_RE = /\.[cm]?[jt]sx?$/i;
// The marker only counts after a `//`, `#`, `/*`, `<!--` or `--`
// opener at line start or after whitespace, or after a `*` block
// continuation at line start — so bare marker text in a string literal
// doesn't exempt anything. Not a tokenizer: a string that itself holds an
// opener plus the marker (`"x // glossary-ignore: a"`) still counts. The
// alias list runs to `-->`, `*/` or end of line. Comma-split only
// (aliases may hold spaces).
const IGNORE_MARKER_RE =
  /(?:^\s*\*|(?:^|\s)(?:\/\/+|#+|\/\*+|<!--|--))\s*glossary-ignore:\s*(.*?)\s*(?:-->|\*\/|$)/i;
const EXPORT_DECLARATION_RE =
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const\s+enum|const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
/** Declarations whose `{ … }` body lists members that are part of the exported name's surface. */
const MEMBER_BLOCK_KINDS: ReadonlySet<string> = new Set(["class", "interface", "type", "enum", "const enum"]);
const HIDDEN_MEMBER_RE = /^\s*(?:private|protected)\s|^\s*#/;
const MEMBER_RE =
  /^\s*(?:(?:public|static|readonly|abstract|override|async|declare|get|set)\s+)*([A-Za-z_$][\w$]*)[?!]?\s*(?:[:(<=,;]|$)/;

function parseIgnoreMarker(text: string): string[] {
  const raw = text.match(IGNORE_MARKER_RE)?.[1];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^[`"']+|[`"'.;]+$/g, "").trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Split a unified diff into hunks of new-revision (added + context) lines. Removed lines are dropped. */
function parseHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentPath = "";
  let current: DiffHunk | undefined;
  let newLineNo = 0;
  const openHunk = (): DiffHunk => {
    const hunk: DiffHunk = { path: currentPath, start: newLineNo, lines: [] };
    hunks.push(hunk);
    return hunk;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const m = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      currentPath = m?.[1] === undefined || m[1] === "/dev/null" ? "" : m[1];
      current = undefined;
      continue;
    }
    if (raw.startsWith("--- ")) continue;

    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header?.[1]) {
      newLineNo = parseInt(header[1], 10);
      current = openHunk();
      continue;
    }

    const added = raw.startsWith("+");
    if (added || raw.startsWith(" ")) {
      // Lines before any `@@` header (a bare `+line` snippet) form an implicit hunk.
      current ??= openHunk();
      current.lines.push({ added, lineNumber: newLineNo, text: raw.slice(1) });
      newLineNo++;
    }
    // removed (`-`) line — new-revision counter doesn't advance.
    // diff --git / index / mode lines etc — ignored, no counter effect.
  }

  return hunks;
}

/** Net `{`/`}` on a line, ignoring string literals and a trailing `//` comment. Approximate: not a tokenizer. */
function braceDelta(text: string): number {
  const code = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$/, "");
  let delta = 0;
  for (const char of code) {
    if (char === "{") delta++;
    else if (char === "}") delta--;
  }
  return delta;
}

/**
 * Which of a Markdown hunk's lines sit inside a fenced code block.
 *
 * A hunk only shows a window of the file, so its first fence may be the
 * closer of a block opened above it. To lean toward flagging (a false
 * positive has the `glossary-ignore` escape hatch; a false negative is
 * invisible):
 *   - a fence only counts once its parity is certain: the hunk starts at
 *     new-file line 1, or an opener carries an info string (```ts — a
 *     closer never does). Until then bare fences are ignored.
 *   - in a hunk that starts mid-file, a block counts only when its
 *     closer is also in the hunk. An unclosed "opener" may be the closer
 *     of an outer block (e.g. ```` around a ```ts example).
 * Residual miss: two misread outer closers inside one mid-file hunk can
 * still pair up and hide the prose between them.
 */
function fencedLines(texts: readonly string[], startsAtTop: boolean): boolean[] {
  const fenced = texts.map(() => false);
  let certain = startsAtTop;
  let open: { char: string; length: number; from: number } | undefined;

  texts.forEach((raw, i) => {
    const fence = raw.replace(/\r$/, "").match(FENCE_RE);
    const marker = fence?.[1];
    const info = (fence?.[2] ?? "").trim();
    if (open) {
      if (marker && marker[0] === open.char && marker.length >= open.length && info === "") {
        fenced.fill(true, open.from, i + 1);
        open = undefined;
      }
      return;
    }
    if (!marker) return;
    // A backtick fence's info string may not contain a backtick.
    if (marker[0] === "`" && info.includes("`")) return;
    if (info !== "") certain = true;
    if (certain) open = { char: marker[0] ?? "`", length: marker.length, from: i };
  });

  if (open && startsAtTop) fenced.fill(true, open.from);
  return fenced;
}

/** Blank out Markdown inline code spans (`x`, ``x``) so names quoted as code don't match. */
function stripInlineCode(text: string): string {
  return text.replace(/(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, (span) => " ".repeat(span.length));
}


function isMarkdownPath(path: string): boolean {
  return MARKDOWN_PATH_RE.test(path);
}

/**
 * True when `alias` appears in `text` somewhere other than inside a
 * canonical term. A glossary's `_Avoid_` list is local to its term: where
 * `score` is an alias under one term and `Score` is a term of its own, or
 * `tier` is an alias and `Hull tier` a term, a word match on the canonical
 * wording says nothing.
 */
function proseUsesAlias(text: string, alias: string, termSpans: readonly Span[]): boolean {
  return literalSpans(alias, text).some((span) => !termSpans.some((term) => isInside(span, term)));
}

function proseCandidate(
  hunk: DiffHunk,
  lineNumber: number,
  prose: string,
  terms: readonly string[],
  ignored: ReadonlySet<string>,
): Candidate {
  const termSpans = terms.flatMap((term) => literalSpans(term, prose));
  return { path: hunk.path, lineNumber, uses: (alias) => proseUsesAlias(prose, alias, termSpans), ignored };
}

/**
 * Added prose lines of a Markdown hunk. Fenced code blocks are skipped,
 * inline code spans are blanked, and a marker inside a fenced block is
 * quoted code and doesn't count.
 */
function markdownCandidates(hunk: DiffHunk, terms: readonly string[]): Candidate[] {
  const fenced = fencedLines(
    hunk.lines.map((l) => l.text),
    hunk.start <= 1,
  );
  const ignored = new Set<string>();
  hunk.lines.forEach((l, i) => {
    if (fenced[i]) return;
    for (const alias of parseIgnoreMarker(l.text)) ignored.add(alias);
  });

  return hunk.lines.flatMap((l, i) =>
    l.added && !fenced[i] ? [proseCandidate(hunk, l.lineNumber, stripInlineCode(l.text), terms, ignored)] : [],
  );
}

/** Added standalone comment lines of a source hunk. A trailing comment after code is not read. */
function commentCandidates(hunk: DiffHunk, terms: readonly string[], ignored: ReadonlySet<string>): Candidate[] {
  return hunk.lines.flatMap((l) => {
    const comment = l.added ? COMMENT_LINE.exec(l.text)?.[1] : undefined;
    return comment === undefined ? [] : [proseCandidate(hunk, l.lineNumber, stripInlineCode(comment), terms, ignored)];
  });
}

/** Start indexes of every run of `words` inside `nameWords`. */
function wordRuns(nameWords: readonly string[], words: readonly string[]): Span[] {
  if (words.length === 0) return [];
  const runs: Span[] = [];
  for (let at = 0; at + words.length <= nameWords.length; at++) {
    if (words.every((word, i) => nameWords[at + i] === word)) runs.push([at, at + words.length]);
  }
  return runs;
}

/**
 * Exported names that added lines of a JS/TS hunk declare: the name after
 * `export const|function|class|interface|type|enum|namespace`, and the
 * public members of an exported class, interface, type literal or enum
 * whose opening line is inside the same hunk.
 *
 * An alias matches as a run of whole words — `owner` in `setOwner`, never
 * `run` in `runner` — and, as in prose, not inside a canonical term.
 *
 * A member whose declaration starts above the hunk is not reported: a
 * hunk does not say what encloses it, and guessing would flag object
 * literals and call statements. Re-exports (`export { a }`) are skipped
 * because the name is declared, and checked, where it is defined.
 */
function nameCandidates(hunk: DiffHunk, terms: readonly string[], ignored: ReadonlySet<string>): Candidate[] {
  const candidates: Candidate[] = [];

  // Brace depth inside an exported member block; undefined outside one.
  let depth: number | undefined;
  for (const l of hunk.lines) {
    const record = (name: string): void => {
      if (!l.added) return;
      const nameWords = wordsOf(name);
      const termRuns = terms.flatMap((term) => wordRuns(nameWords, wordsOf(term)));
      candidates.push({
        path: hunk.path,
        lineNumber: l.lineNumber,
        name,
        uses: (alias) =>
          wordRuns(nameWords, wordsOf(alias)).some((run) => !termRuns.some((term) => isInside(run, term))),
        ignored,
      });
    };

    if (depth === undefined) {
      const declaration = EXPORT_DECLARATION_RE.exec(l.text);
      const kind = declaration?.[1]?.replace(/\s+/g, " ");
      const name = declaration?.[2];
      if (kind === undefined || name === undefined) continue;
      record(name);
      const opened = braceDelta(l.text);
      if (MEMBER_BLOCK_KINDS.has(kind) && opened > 0) depth = opened;
      continue;
    }

    const member = depth === 1 && !HIDDEN_MEMBER_RE.test(l.text) ? MEMBER_RE.exec(l.text)?.[1] : undefined;
    if (member !== undefined) record(member);
    depth += braceDelta(l.text);
    if (depth <= 0) depth = undefined;
  }

  return candidates;
}

/**
 * Every place the diff's added lines could use an alias, in diff order:
 * Markdown prose, standalone comment lines of any other file, and the
 * exported names of JS/TS files.
 */
function candidatesOf(diff: string, terms: readonly string[]): Candidate[] {
  return parseHunks(diff).flatMap((hunk) => {
    if (isMarkdownPath(hunk.path)) return markdownCandidates(hunk, terms);

    const ignored = new Set<string>();
    for (const l of hunk.lines) for (const alias of parseIgnoreMarker(l.text)) ignored.add(alias);
    const comments = commentCandidates(hunk, terms, ignored);
    if (!SOURCE_PATH_RE.test(hunk.path)) return comments;
    return [...comments, ...nameCandidates(hunk, terms, ignored)].sort((a, b) => a.lineNumber - b.lineNumber);
  });
}

/** Lower-cased words of an identifier or alias: `setOwner`, `SET_OWNER` and `set-owner` all give `set`, `owner`. */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/** External TypeSafe contract paths use TypeSafe's vocabulary, not Sage's. */
function isTypeSafeBoundaryPath(path: string): boolean {
  return /(?:^|[./-])typesafe(?:[./-]|$)/i.test(path);
}

/** The exemption marker as an author should write it — shared by finding rationales and the lens-stdin excerpt. */
function markerSyntax(alias: string, markdown: boolean): string {
  return markdown
    ? `\`<!-- glossary-ignore: ${alias} -->\``
    : `\`// glossary-ignore: ${alias}\` (or \`# …\`)`;
}

function quoteTerms(terms: readonly string[], quote: string, separator: string): string {
  return terms.map((t) => `${quote}${t}${quote}`).join(separator);
}

interface AliasGroup {
  path: string;
  alias: string;
  lines: number[];
  /** The exported name on the first line, for a source declaration. */
  name: string | undefined;
  entries: GlossaryEntry[];
}

/** One Avoid-alias finding for `alias` in `path`, at its first declaring line, naming every canonical term it belongs to. */
function buildViolation(group: AliasGroup): Finding {
  const { path, alias, lines, name, entries: matched } = group;
  const line = lines[0] ?? 0;
  const more = lines.slice(1);
  const elsewhere =
    more.length === 0
      ? ""
      : ` Also on line${more.length === 1 ? "" : "s"} ${more.slice(0, 5).join(", ")}${more.length > 5 ? ` and ${more.length - 5} more` : ""}.`;
  const terms = matched.map((e) => e.term);
  const citations = matched
    .map(
      (e) =>
        `CONTEXT.md${e.section ? ` §${e.section}` : ""} — canonical term \`${e.term}\` (avoid: ${e.avoid.join(", ")}) — source CONTEXT.md:${e.line}`,
    )
    .join("; ");
  const termPhrase =
    terms.length === 1
      ? `canonical term \`${terms[0]}\`. Use \`${terms[0]}\` instead`
      : `canonical terms ${quoteTerms(terms, "`", ", ")}. Use one of those instead`;
  return {
    path,
    line,
    // A vocabulary match is wording, never a merge gate: the matcher cannot
    // tell the domain term from the plain-English word ("command", "hangar")
    // or a library name (Blender's "Modifier"). On seelite#829 it raised 45
    // `important` findings a round and blocked a handoff PR on its own.
    severity: "nit",
    impact: "prose",
    title: `Avoid alias "${alias}" — use ${quoteTerms(terms, '"', " or ")}`,
    rationale: `${name === undefined ? "Added line" : `Exported name \`${name}\``} uses \`${alias}\`, a CONTEXT.md _Avoid_ alias for ${termPhrase}, or mark the alias as intentional with ${markerSyntax(alias, isMarkdownPath(path))} on this line or in the same hunk.${elsewhere} ${citations}`,
  };
}

export function applyGlossaryIgnore(
  entries: readonly GlossaryEntry[],
  ignore: readonly string[],
): GlossaryEntry[] {
  const ignored = new Set(ignore.map((alias) => alias.trim().toLowerCase()));
  return entries.map((entry) => ({
    ...entry,
    avoid: entry.avoid.filter((alias) => !ignored.has(alias.toLowerCase())),
  }));
}

/**
 * Deterministic (non-model) `_Avoid_`-alias violations on added diff
 * lines, in three places: Markdown prose, standalone source comments,
 * and the exported names that JS/TS files declare. Severity `nit`,
 * impact `prose`: a hit never blocks the merge gate, because an
 * exact-word match cannot tell a domain term from the same word in
 * plain English.
 *
 *   - Markdown fenced code blocks and inline code spans are skipped —
 *     quoted code (`spawn` from `node:child_process`) isn't prose.
 *   - An alias inside a canonical term is not a hit: `score` is not
 *     flagged where `Score` is itself a term, nor `tier` in `Hull tier`.
 *   - One finding per (file, alias): an alias listed under several
 *     canonical terms is reported once, naming every term, at its first
 *     added line, with the file's other hits listed in the rationale.
 *   - A `glossary-ignore: <alias>[, <alias>…]` marker after a `//`,
 *     `#`, `/*`, `<!--` or `--` opener on any added or context line of
 *     the same hunk exempts those aliases there.
 */
export function findGlossaryViolations(
  entries: readonly GlossaryEntry[],
  diff: string,
): Finding[] {
  // Keyed `path\0alias`; Map order keeps findings in diff order.
  const byFileAlias = new Map<string, AliasGroup>();

  const terms = entries.map((entry) => entry.term);
  for (const { path, lineNumber, name, uses, ignored } of candidatesOf(diff, terms)) {
    if (isTypeSafeBoundaryPath(path)) continue;

    for (const entry of entries) {
      for (const alias of entry.avoid) {
        const key = alias.toLowerCase();
        if (ignored.has(key)) continue;
        if (!uses(alias)) continue;
        const fileKey = `${path}\0${key}`;
        const group = byFileAlias.get(fileKey) ?? { path, alias, lines: [], name, entries: [] };
        if (!group.lines.includes(lineNumber)) group.lines.push(lineNumber);
        if (!group.entries.includes(entry)) group.entries.push(entry);
        byFileAlias.set(fileKey, group);
      }
    }
  }

  return [...byFileAlias.values()].map(buildViolation);
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
