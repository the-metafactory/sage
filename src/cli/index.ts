#!/usr/bin/env bun
import { Command } from "commander";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parsePrRef } from "../forge/parse.ts";
import { selectForge } from "../forge/select.ts";
import type { ForgeKind } from "../forge/types.ts";
import {
  parseConcurrencyValue,
  readConcurrencyEnv,
  reviewPr,
} from "../lenses/workflow.ts";
import { selectSubstrate } from "../substrate/select.ts";
import { renderVerdict } from "../verdict/index.ts";
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

const program = new Command();

program
  .name("sage")
  .description(
    "Sage — botanical code-review agent on pi.dev, Claude Code, or Codex CLI, speaking Myelin envelopes",
  )
  .version("0.1.0");

program
  .command("review")
  .description(
    "Review a single PR/MR offline (no bus). Prints rendered review to stdout. Accepts GitHub or GitLab refs.",
  )
  .argument("<pr-ref>", "PR/MR URL or OWNER/REPO#N (GitHub) or GROUP/PROJ!N (GitLab)")
  .option("--post", "Post the review back to the PR/MR via the forge CLI", false)
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
  .action(
    async (prRef: string, opts: {
      post: boolean;
      timeout: number;
      substrate?: string;
      forge?: string;
      gitlabHost?: string;
      lensConcurrency?: string;
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
      const refLabel =
        forgeSelection.kind === "gitlab"
          ? `${ref.owner}/${ref.repo}!${ref.number}`
          : `${ref.owner}/${ref.repo}#${ref.number}`;
      console.error(
        `[sage] reviewing ${refLabel} via ${forgeSelection.kind} (${forgeSelection.source}) on ${selection.substrate.displayName} (${selection.source}, timeout=${opts.timeout}s, lensConcurrency=${lensConcurrency ?? "unbounded"})`,
      );
      const result = await reviewPr({
        ref,
        forge: forgeSelection.backend,
        post: opts.post,
        substrate: selection.substrate,
        timeoutMs: opts.timeout * 1000,
        ...(lensConcurrency !== undefined ? { lensConcurrency } : {}),
      });
      const body = renderVerdict(result.verdict, selection.substrate.displayName);
      console.log(body);
      console.error(`[sage] verdict: ${result.verdict.decision} (posted=${result.posted})`);
      if (result.verdict.decision === "changes-requested") {
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
  .command("dispatch")
  .description(
    "Publish a code-review task envelope to the Myelin bus and stream the verdict back. Requires a running cortex with sage wired as an in-process agent (sage#40).",
  )
  .argument("<pr-ref>", "PR URL or OWNER/REPO#N")
  .option("--nats <url>", "NATS broker URL", process.env.NATS_URL ?? "nats://localhost:4222")
  .option("--org <org>", "Org segment", process.env.SAGE_ORG ?? "metafactory")
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
    process.env.SAGE_STACK,
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
