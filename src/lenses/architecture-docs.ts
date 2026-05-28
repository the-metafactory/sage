import type { ForgeBackend, PrRef } from "../forge/types.ts";

export const ARCHITECTURE_DOC_PATHS = [
  "CONTEXT.md",
  "docs/architecture.md",
  "compass/ecosystem/CONTEXT-MAP.md",
] as const;

const MAX_DOC_CHARS = 50_000;

export type ArchitectureDocPath = (typeof ARCHITECTURE_DOC_PATHS)[number];

export interface ArchitectureDoc {
  readonly path: ArchitectureDocPath;
  readonly status: "loaded" | "not-found";
  readonly content: string;
  readonly truncated: boolean;
}

export interface ArchitectureDocsContext {
  readonly docs: readonly ArchitectureDoc[];
  readonly provenance: string;
  readonly hasLoadedDocs: boolean;
}

function truncateDoc(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_DOC_CHARS) {
    return { content, truncated: false };
  }
  return {
    content: content.slice(0, MAX_DOC_CHARS),
    truncated: true,
  };
}

export async function loadArchitectureDocs(opts: {
  readonly forge: ForgeBackend;
  readonly ref: PrRef;
  readonly baseRefName?: string;
}): Promise<ArchitectureDocsContext> {
  const docs = await Promise.all(
    ARCHITECTURE_DOC_PATHS.map(async (path): Promise<ArchitectureDoc> => {
      try {
        const raw = await opts.forge.repoFile(opts.ref, path, {
          ...(opts.baseRefName ? { refName: opts.baseRefName } : {}),
        });
        if (raw === null) {
          return { path, status: "not-found", content: "", truncated: false };
        }
        const truncated = truncateDoc(raw);
        return { path, status: "loaded", ...truncated };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[workflow] architecture docs: ${path} unavailable: ${message}`);
        return { path, status: "not-found", content: "", truncated: false };
      }
    }),
  );

  const provenance =
    `architecture-docs: ${docs.map((d) => `${d.path} (${d.status})`).join(", ")}` +
    (docs.some((d) => d.status === "loaded")
      ? ""
      : " - running legacy heuristic checklist only");

  return {
    docs,
    provenance,
    hasLoadedDocs: docs.some((d) => d.status === "loaded"),
  };
}

export function renderArchitectureDocs(ctx: ArchitectureDocsContext): string {
  const loadedDocs = ctx.docs.filter((d) => d.status === "loaded");
  if (loadedDocs.length === 0) {
    return `Architecture context docs:\n${ctx.provenance}`;
  }

  const renderedDocs = loadedDocs
    .map((doc) => {
      const suffix = doc.truncated
        ? `\n\n[truncated after ${MAX_DOC_CHARS} characters]`
        : "";
      return `--- ${doc.path} ---\n${doc.content}${suffix}`;
    })
    .join("\n\n");

  return `Architecture context docs:
${ctx.provenance}

Use these documents as the repository's architecture contract. For CONTEXT.md,
watch for canonical terms, Avoid aliases, bounded-context language, and explicit
responsibility boundaries. For docs/architecture.md and CONTEXT-MAP.md, check
layer ownership and ecosystem term reconciliation. Findings derived from these
documents must cite the source path and line/section when possible.

${renderedDocs}`;
}
