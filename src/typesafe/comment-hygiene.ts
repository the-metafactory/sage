import type { TypeSafePolicy } from "./policy.ts";
import { redactTypeSafeText } from "./state.ts";
import type { BoundedCommentState, CommentSpan } from "./types.ts";

const JS_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs"];
const DOCSTRING_EXTENSIONS = new Set(["py", "pyi", "rb", "rake", "pl", "pm", ...JS_EXTENSIONS]);
const JSDOC_EXTENSIONS = new Set(JS_EXTENSIONS);

function extension(path: string): string {
  return path.split(".").at(-1)?.toLowerCase() ?? "";
}

interface ClassifiedComment {
  syntax: CommentSpan["syntax"];
  text: string;
}

function classifyComment(path: string, text: string, inJsDoc: boolean, inBlockComment: boolean): ClassifiedComment | undefined {
  const trimmed = text.trim();
  if (JSDOC_EXTENSIONS.has(extension(path)) && (inJsDoc || /^\/\*\*/.test(trimmed))) {
    return { syntax: "docstring", text: trimmed };
  }
  if (/^<!--/.test(trimmed)) return { syntax: "markup_comment", text: trimmed };
  if (/^\/\*/.test(trimmed) || (inBlockComment && /^(?:\*|\*\/)/.test(trimmed))) {
    return { syntax: "block_comment", text: trimmed };
  }
  if (/^(?:\/\/|#|--|;)/.test(trimmed)) return { syntax: "line_comment", text: trimmed };
  if (DOCSTRING_EXTENSIONS.has(extension(path)) && /(?:^|\s)(?:\"\"\"|''')/.test(trimmed)) {
    return { syntax: "docstring", text: trimmed };
  }
  // Keep inline source comments, but strip the executable prefix before this
  // state crosses the external boundary. The marker must be at the start of
  // the line or preceded by whitespace to avoid URL and string fragments.
  const inline = text.match(/(?:^|\s)(\/\/|#|--)\s.*$/);
  if (inline?.index !== undefined) {
    const markerOffset = text.indexOf(inline[1]!, inline.index);
    return { syntax: "line_comment", text: text.slice(markerOffset).trim() };
  }
  return undefined;
}

interface RawCommentSpan {
  path: string;
  line: number;
  syntax: CommentSpan["syntax"];
  text: string;
  declarationContext?: string;
}

type MutableCommentSpan = { -readonly [K in keyof CommentSpan]: CommentSpan[K] };

function declarationSignature(path: string, text: string): string | undefined {
  const trimmed = text.trim();
  if (JSDOC_EXTENSIONS.has(extension(path))) {
    return /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type)\s+/.test(trimmed) ||
      /^(?:export\s+)?const\s+[A-Za-z_$]/.test(trimmed)
      ? trimmed.replace(/\s*(?:\{|=>|=).*$/, "").trimEnd()
      : undefined;
  }
  switch (extension(path)) {
    case "py":
    case "pyi":
      return /^(?:async\s+)?(?:def|class)\s+/.test(trimmed) ? trimmed : undefined;
    case "rb":
    case "rake":
      return /^(?:def|class|module)\s+/.test(trimmed) ? trimmed : undefined;
    case "pl":
    case "pm":
      return /^(?:sub|package)\s+/.test(trimmed) ? trimmed : undefined;
    default:
      return undefined;
  }
}

/**
 * Extract only added comment/docstring lines from a unified diff. This is a
 * syntax-aware, fail-closed filter: uncertain source lines are excluded rather
 * than sending surrounding executable code to the external service.
 */
function addedCommentSpans(diff: string): RawCommentSpan[] {
  const spans: RawCommentSpan[] = [];
  let path = "(unknown)";
  let newLine = 0;
  let inHunk = false;
  let precedingDeclaration: string | undefined;
  let inJsDoc = false;
  let inBlockComment = false;
  let pendingFollowingDocstring: RawCommentSpan | undefined;

  for (const line of diff.split("\n")) {
    const file = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (file) {
      path = file[2]!;
      inHunk = false;
      precedingDeclaration = undefined;
      inJsDoc = false;
      inBlockComment = false;
      pendingFollowingDocstring = undefined;
      continue;
    }
    const hunk = line.match(/^@@ [^+]*\+(\d+)/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      precedingDeclaration = undefined;
      inJsDoc = false;
      inBlockComment = false;
      pendingFollowingDocstring = undefined;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      const text = line.slice(1);
      const syntax = classifyComment(path, text, inJsDoc, inBlockComment);
      if (syntax) {
        const previous = spans.at(-1);
        if (syntax.syntax === "docstring" && previous?.syntax === "docstring" &&
          previous.path === path && previous.line + previous.text.split("\n").length === newLine) {
          previous.text = `${previous.text}\n${syntax.text}`;
        } else {
          spans.push({
            path,
            line: newLine,
            syntax: syntax.syntax,
            text: syntax.text,
            ...(syntax.syntax === "docstring" && precedingDeclaration
              ? { declarationContext: precedingDeclaration }
              : {}),
          });
        }
        precedingDeclaration = undefined;
        if (syntax.syntax === "docstring" && JSDOC_EXTENSIONS.has(extension(path))) {
          inJsDoc = !text.includes("*/");
          if (!inJsDoc) pendingFollowingDocstring = spans.at(-1);
        }
        if (syntax.syntax === "block_comment") inBlockComment = !text.includes("*/");
      } else {
        const declaration = declarationSignature(path, text);
        if (pendingFollowingDocstring) {
          if (declaration) pendingFollowingDocstring.declarationContext = declaration;
          pendingFollowingDocstring = undefined;
        }
        precedingDeclaration = declaration;
        inJsDoc = false;
        inBlockComment = false;
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return spans;
}

export function buildBoundedCommentState(diff: string, policy: TypeSafePolicy): BoundedCommentState {
  const raw = addedCommentSpans(diff);
  const comments: MutableCommentSpan[] = [];
  let remaining = policy.commentHygiene.maxStateChars;
  let spansTruncated = 0;

  for (const [index, span] of raw.entries()) {
    if (comments.length >= policy.commentHygiene.maxSpans || remaining <= 0) break;
    const redacted = redactTypeSafeText(span.text);
    const text = redacted.slice(0, Math.min(policy.commentHygiene.maxSpanChars, remaining));
    const truncated = text.length < redacted.length;
    if (truncated) spansTruncated++;
    comments.push({
      id: `comment_${index + 1}`,
      path: redactTypeSafeText(span.path),
      line: span.line,
      syntax: span.syntax,
      text,
      ...(span.declarationContext
        ? { declarationContext: redactTypeSafeText(span.declarationContext).slice(0, policy.commentHygiene.maxDeclarationContextChars) }
        : {}),
      originalChars: span.text.length,
      retainedChars: text.length,
      truncated,
    });
    remaining -= text.length;
  }

  const state = {
    comments,
    truncation: {
      spansDetected: raw.length,
      spansRetained: comments.length,
      spansTruncated,
      stateTruncated: raw.length > comments.length || spansTruncated > 0,
    },
  };
  while (JSON.stringify(state).length > policy.commentHygiene.maxStateChars) {
    const span = state.comments.at(-1);
    if (span?.text.length) {
      span.text = span.text.slice(0, -1);
      span.retainedChars = span.text.length;
      span.truncated = true;
      state.truncation.spansTruncated = state.comments.filter((candidate) => candidate.truncated).length;
      state.truncation.stateTruncated = true;
      continue;
    }
    if (span) {
      state.comments.pop();
      state.truncation.spansRetained = state.comments.length;
      state.truncation.stateTruncated = true;
      continue;
    }
    throw new Error("TypeSafe comment-hygiene maxStateChars is too small for the fixed state schema");
  }
  return state;
}
