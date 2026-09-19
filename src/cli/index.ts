#!/usr/bin/env bun
import { Command } from "commander";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import packageJson from "../../package.json";
import { cortexConfigPath, resolveDefaultPrincipal, resolveDefaultStack } from "../config.ts";
import { parsePrRef } from "../forge/parse.ts";
import { selectForge } from "../forge/select.ts";
import type { ForgeKind } from "../forge/types.ts";
import {
  parseConcurrencyValue,
  readConcurrencyEnv,
  reviewPr,
} from "../lenses/workflow.ts";
import { selectSubstrate } from "../substrate/select.ts";
import {
  createFileShadowSink,
  createHttpTypeSafeTransport,
  createTypeSafeShadowObserver,
  loadCorpusManifest,
  type TypeSafeMode,
  type TypeSafeShadowObserver,
} from "../typesafe/index.ts";
import { renderVerdict, renderVerdictBlock } from "../verdict/index.ts";
import { dispatchReview } from "./dispatch.ts";

/**
 * Boolean parse for `SAGE_REQUIRE_NATS_AUTH`. Used by the `dispatch` action
 * to mirror the daemon-side enforcement that now lives in cortex (sage#40 —
 * sage moved from standalone launchd daemon to in-process cortex agent;
 * cortex's `ReviewConsumer` owns the subscribe loop, sage exposes
 * `reviewPr` as a `pipelineRunner` library).
 */
function requiresNatsAuth(): boolean {
  const v = process.env.SAGE_REQUIRE_NATS_AUTH;
  return v === "1" || v === "true";
}

function resolveLensConcurrency(raw: string | undefined): number | undefined {
  return (
    parseConcurrencyValue(raw, "--lens-concurrency") ??
    readConcurrencyEnv("SAGE_LENS_CONCURRENCY")
  );
}

function parseForgeKind(raw: string | undefined): ForgeKind | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "github" || raw === "gitlab") return raw;
  throw new Error(`--forge must be "github" or "gitlab" (got ${JSON.stringify(raw)})`);
}

function parseTypeSafeMode(raw: string): TypeSafeMode {
  if (raw === "off" || raw === "shadow") return raw;
  throw new Error(`--typesafe-mode must be "off" or "shadow" (got ${JSON.stringify(raw)})`);
}

function buildTypeSafeShadow(
  mode: TypeSafeMode,
  corpusPath: string,
): TypeSafeShadowObserver | undefined {
  if (mode === "off") return undefined;
  try {
    const corpus = loadCorpusManifest(corpusPath);
    const apiKey = process.env.TYPESAFE_API_KEY;
    const timeoutMs = Number(process.env.SAGE_TYPESAFE_TIMEOUT_MS ?? 5_000);
    const repeatCount = Number(process.env.SAGE_TYPESAFE_REPEATS ?? 1);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("SAGE_TYPESAFE_TIMEOUT_MS must be a positive integer");
    }
    if (!Number.isInteger(repeatCount) || repeatCount <= 0 || repeatCount > 10) {
      throw new Error("SAGE_TYPESAFE_REPEATS must be an integer from 1 to 10");
    }
    return createTypeSafeShadowObserver({
      mode,
      corpus,
      sink: createFileShadowSink(),
      ...(apiKey ? { transport: createHttpTypeSafeTransport({ apiKey }) } : {}),
      timeoutMs,
      repeatCount,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[sage] TypeSafe shadow disabled (ordinary review continues): ${detail}`);
    return undefined;
  }
}

const program = new Command();

program
  .name("sage")
  .description(
    "Sage — botanical code-review agent on pi.dev, Claude Code, or Codex CLI, speaking Myelin envelopes",
  )
  .version(packageJson.version);

program
  .command("review")
  .description(
    "Review a single PR/MR offline (no bus). Prints rendered review to stdout. Accepts GitHub or GitLab refs.",
  )
  .argument("<pr-ref>", "PR/MR URL or OWNER/REPO#N (GitHub) or GROUP/PROJ!N (GitLab)")
  .option("--post", "Post the review back to the PR/MR via the forge CLI", false)
  .option(
    "--emit-verdict-block",
    "Append the cortex structured verdict block (fenced ```json) as the terminal stdout artefact. cortex's pi-dev substrate parses it to recover the decision + findings counts.",
    false,
  )
  .option(
    "--substrate <name>",
    "Coding harness Sage runs through ({pi|claude|codex}). Falls back to SAGE_SUBSTRATE / config / pi.",
  )
  .option(
    "--forge <kind>",
    "Forge backend ({github|gitlab}). Falls back to SAGE_FORGE env / URL detection / github.",
  )
  .option(
    "--gitlab-host <host>",
    "GitLab host for the gitlab backend (default gitlab.com; falls back to SAGE_GITLAB_HOST).",
  )
  .option(
    "--timeout <seconds>",
    "Per-lens substrate timeout in seconds (default 600 / 10min)",
    (v) => parseInt(v, 10),
    Number(process.env.SAGE_REVIEW_TIMEOUT ?? 600),
  )
  .option(
    "--lens-concurrency <n>",
    "Max concurrent lenses (default unbounded; env SAGE_LENS_CONCURRENCY)",
  )
  .option(
    "--typesafe-mode <mode>",
    "TypeSafe advisory proof-of-value mode (off|shadow). Shadow is corpus-gated and cannot affect Sage output.",
    process.env.SAGE_TYPESAFE_MODE ?? "off",
  )
  .option(
    "--typesafe-corpus <path>",
    "Frozen approved corpus manifest used to authorize shadow requests.",
    process.env.SAGE_TYPESAFE_CORPUS ??
      join(import.meta.dir, "..", "..", "evaluation", "typesafe", "corpus.json"),
  )
  .action(
    async (prRef: string, opts: {
      post: boolean;
      emitVerdictBlock: boolean;
      timeout: number;
      substrate?: string;
      forge?: string;
      gitlabHost?: string;
      lensConcurrency?: string;
      typesafeMode: string;
      typesafeCorpus: string;
    }) => {
      const forgeSelection = selectForge({
        ...(opts.forge !== undefined ? { flag: opts.forge } : {}),
        fromRef: prRef,
        ...(opts.gitlabHost !== undefined ? { gitlabHost: opts.gitlabHost } : {}),
      });
      const ref = parsePrRef(prRef, forgeSelection.kind);
      const auth = await forgeSelection.backend.authStatus();
      if (!auth.ok) {
        const cliName = forgeSelection.kind === "gitlab" ? "glab" : "gh";
        console.error(`${cliName} auth is not configured. Run \`${cliName} auth login\` first.`);
        console.error(auth.output);
        process.exit(2);
      }

      const selection = selectSubstrate({ flag: opts.substrate });
      const lensConcurrency = resolveLensConcurrency(opts.lensConcurrency);
      const typeSafeMode = parseTypeSafeMode(opts.typesafeMode);
      const typeSafeShadow = buildTypeSafeShadow(typeSafeMode, opts.typesafeCorpus);
      const refLabel =
        forgeSelection.kind === "gitlab"
          ? `${ref.owner}/${ref.repo}!${ref.number}`
          : `${ref.owner}/${ref.repo}#${ref.number}`;
      console.error(
        `[sage] reviewing ${refLabel} via ${forgeSelection.kind} (${forgeSelection.source}) on ${selection.substrate.displayName} (${selection.source}, timeout=${opts.timeout}s, lensConcurrency=${lensConcurrency ?? "unbounded"})`,
      );
      const review = await reviewPr({
        ref,
        forge: forgeSelection.backend,
        post: opts.post,
        substrate: selection.substrate,
        timeoutMs: opts.timeout * 1000,
        ...(lensConcurrency !== undefined ? { lensConcurrency } : {}),
        ...(typeSafeShadow ? { completedReviewObserver: typeSafeShadow } : {}),
      });
      const body = renderVerdict(review.verdict, selection.substrate.displayName);
      // The verdict block MUST be the terminal artefact: cortex's
      // extractVerdictBlock picks the LAST ```json fence in stdout.
      const out = opts.emitVerdictBlock
        ? `${body}\n\n${renderVerdictBlock(review.verdict, review.blockMeta)}`
        : body;
      console.log(out);
      console.error(`[sage] verdict: ${review.verdict.decision} (posted=${review.posted})`);
      await review.observerCompletion;
      if (review.verdict.decision === "changes-requested") {
        process.exit(1);
      }
    },
  );

// sage#40 — the `serve` command has been retired. Sage is now an
// in-process cortex agent: cortex's `ReviewConsumer` owns the NATS
// subscribe loop, queue-group, ack/nak, redelivery, and lifecycle envelope
// emission (cortex#237 PR-6). Cortex invokes sage's review pipeline as an
// injected `pipelineRunner` — `reviewPr` from `src/lenses/workflow.ts` is
// the entry point.
//
// To run a one-off review without the bus, use `sage review <pr-ref>`.
// To trigger a review through cortex's in-process sage from the CLI side,
// use `sage dispatch <pr-ref>` (publisher half — receiver is cortex).

program
  .command("context")
  .description("Print the Cortex dispatch context Sage will use; does not connect or publish.")
  .action(() => {
    const config = cortexConfigPath();
    const principal = resolveDefaultPrincipal();
    const stack = process.env.SAGE_STACK ?? resolveDefaultStack() ?? "default";
    console.log(JSON.stringify({ config, principal, stack }, null, 2));
  });

program
  .command("dispatch")
  .description(
    "Publish a code-review task envelope to the Myelin bus and stream the verdict back. Requires a running cortex with sage wired as an in-process agent (sage#40).",
  )
  .argument("<pr-ref>", "PR URL or OWNER/REPO#N")
  .option("--nats <url>", "NATS broker URL", process.env.NATS_URL ?? "nats://localhost:4222")
  .option(
    "--org <org>",
    "Principal segment of the publish subject. Default: SAGE_ORG → selected Cortex config (including split default/default.yaml) → metafactory.",
    resolveDefaultPrincipal(),
  )
  .option(
    "--source <src>",
    "Envelope source",
    process.env.SAGE_DISPATCH_SOURCE ?? "metafactory.sage-dispatch.local",
  )
  .option("--creds <file>", "NATS .creds file", process.env.NATS_CREDS_FILE)
  .option("--post", "Ask the receiving daemon to post the review back to GitHub", false)
  .option(
    "--forge <kind>",
    "Forge kind for shorthand refs (github|gitlab); also reads SAGE_FORGE",
    process.env.SAGE_FORGE,
  )
  .option(
    "--wait <seconds>",
    "Max seconds to wait for the verdict before timing out (default 900)",
    (v) => parseInt(v, 10),
    Number(process.env.SAGE_DISPATCH_WAIT ?? 900),
  )
  .option(
    "--timeout <seconds>",
    "Per-lens pi timeout to forward to the daemon (default: daemon's own)",
    (v) => parseInt(v, 10),
    process.env.SAGE_DISPATCH_TIMEOUT ? Number(process.env.SAGE_DISPATCH_TIMEOUT) : undefined,
  )
  .option(
    "--residency <code>",
    "Data-residency ISO 3166 alpha-2 code stamped on the task envelope",
    process.env.MYELIN_DATA_RESIDENCY ?? process.env.SAGE_DATA_RESIDENCY,
  )
  .option(
    "--stack <name>",
    "IoAW operator stack segment (defaults to SAGE_STACK env or \"default\")",
    process.env.SAGE_STACK ?? resolveDefaultStack(),
  )
  .action(
    async (
      prRef: string,
      opts: {
        nats: string;
        org: string;
        source: string;
        creds?: string;
        post: boolean;
        wait: number;
        timeout?: number;
        residency?: string;
        stack?: string;
        forge?: string;
      },
    ) => {
      const requireNatsAuth = requiresNatsAuth();
      const forge = parseForgeKind(opts.forge);

      const exitCode = await dispatchReview({
        prRef,
        natsUrl: opts.nats,
        org: opts.org,
        source: opts.source,
        credsFile: opts.creds,
        post: opts.post,
        waitSeconds: opts.wait,
        ...(opts.timeout ? { timeoutSeconds: opts.timeout } : {}),
        ...(opts.residency ? { dataResidency: opts.residency } : {}),
        ...(requireNatsAuth ? { requireNatsAuth: true } : {}),
        ...(opts.stack ? { stack: opts.stack } : {}),
        ...(forge ? { forge } : {}),
      });
      process.exit(exitCode);
    },
  );

program
  .command("init")
  .description("Write pi.settings.json, sage.config.json, and .env templates into the current directory.")
  .option("--force", "Overwrite existing files", false)
  .action((opts: { force: boolean }) => {
    const cwd = process.cwd();
    const piSettings = join(cwd, "pi.settings.json");
    const sageConfig = join(cwd, "sage.config.json");
    const envFile = join(cwd, ".env");

    const piSettingsContent = JSON.stringify(
      {
        bus: {
          enabled: true,
          natsUrl: process.env.NATS_URL ?? "nats://localhost:4222",
          credentials: "~/.config/nats/creds/sage.creds",
          agentId: "sage",
          capabilities: ["code-review"],
          sovereignty: "selective",
        },
        substrate: {
          binary: "pi",
          provider: process.env.PI_PROVIDER ?? "anthropic",
          model: process.env.PI_MODEL ?? "anthropic/claude-sonnet-4-6",
        },
      },
      null,
      2,
    );

    // Substrate-level config — kept separate from pi.settings.json because
    // pi.settings.json is consumed by pi.dev itself and shouldn't carry
    // sage-internal selection state. Move this file to
    // ~/.config/sage/config.json for daemon-level (machine-wide) defaults.
    const sageConfigContent = JSON.stringify(
      {
        substrate: {
          default: "pi",
          pi: {
            provider: process.env.PI_PROVIDER ?? "anthropic",
            model: process.env.PI_MODEL ?? "anthropic/claude-sonnet-4-6",
          },
          claude: {
            model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
            permissionMode: "acceptEdits",
          },
          codex: {
            model: process.env.CODEX_MODEL ?? "gpt-5.2",
            sandbox: "read-only",
          },
        },
      },
      null,
      2,
    );

    const envContent = [
      "NATS_URL=nats://localhost:4222",
      "SAGE_AGENT_ID=sage",
      "SAGE_DID=did:mf:sage",
      "SAGE_SOURCE=metafactory.sage.local",
      "SAGE_ORG=metafactory",
      "SAGE_DATA_RESIDENCY=CH",
      "# Substrate selection: pi (default), claude, or codex. Falls back to sage.config.json / pi.",
      "# SAGE_SUBSTRATE=pi",
      "PI_BIN=pi",
      "PI_PROVIDER=anthropic",
      "PI_MODEL=anthropic/claude-sonnet-4-6",
      "# SAGE_LENS_CONCURRENCY=1",
      "# CLAUDE_BIN=claude",
      "# CLAUDE_MODEL=claude-sonnet-4-6",
      "# CODEX_BIN=codex",
      "# CODEX_MODEL=gpt-5.2",
      "# CODEX_PROFILE=reviewer",
      "# CODEX_SANDBOX=read-only",
      "",
    ].join("\n");

    const writes: Array<{ path: string; content: string }> = [
      { path: piSettings, content: piSettingsContent },
      { path: sageConfig, content: sageConfigContent },
      { path: envFile, content: envContent },
    ];

    // Pre-flight all conflicts so init fails atomically — no half-written
    // state where one file is created and the others are refused.
    const conflicts = writes.filter((w) => existsSync(w.path));
    if (conflicts.length > 0 && !opts.force) {
      for (const c of conflicts) {
        console.error(`refusing to overwrite ${c.path} (use --force)`);
      }
      process.exit(1);
    }

    for (const w of writes) {
      writeFileSync(w.path, w.content);
      console.error(`wrote ${w.path}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const m = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[sage] error: ${m}`);
  process.exit(1);
});
