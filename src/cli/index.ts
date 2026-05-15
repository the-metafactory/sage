#!/usr/bin/env bun
import { Command } from "commander";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parsePrRef, ghAuthStatus } from "../github/gh.ts";
import { reviewPr, renderReviewBody } from "../lenses/workflow.ts";
import { startBridge } from "../bus/bridge.ts";
import { selectSubstrate } from "../substrate/select.ts";
import { dispatchReview } from "./dispatch.ts";

/**
 * Boolean parse for `SAGE_REQUIRE_NATS_AUTH`. Shared between `serve` and
 * `dispatch` actions so accepted values + env-name changes happen in one
 * place (sage PR#29 R2 maintainability finding).
 */
function requiresNatsAuth(): boolean {
  const v = process.env.SAGE_REQUIRE_NATS_AUTH;
  return v === "1" || v === "true";
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
  .description("Review a single PR offline (no bus). Prints rendered review to stdout.")
  .argument("<pr-ref>", "PR URL or OWNER/REPO#N")
  .option("--post", "Post the review back to the PR via gh", false)
  .option(
    "--substrate <name>",
    "Coding harness Sage runs through ({pi|claude|codex}). Falls back to SAGE_SUBSTRATE / config / pi.",
  )
  .option(
    "--timeout <seconds>",
    "Per-lens substrate timeout in seconds (default 600 / 10min)",
    (v) => parseInt(v, 10),
    Number(process.env.SAGE_REVIEW_TIMEOUT ?? 600),
  )
  .action(
    async (prRef: string, opts: { post: boolean; timeout: number; substrate?: string }) => {
      const ref = parsePrRef(prRef);
      const auth = await ghAuthStatus();
      if (!auth.ok) {
        console.error("gh auth is not configured. Run `gh auth login` first.");
        console.error(auth.output);
        process.exit(2);
      }

      const selection = selectSubstrate({ flag: opts.substrate });
      console.error(
        `[sage] reviewing ${ref.owner}/${ref.repo}#${ref.number} on ${selection.substrate.displayName} (${selection.source}, timeout=${opts.timeout}s)`,
      );
      const result = await reviewPr({
        ref,
        post: opts.post,
        substrate: selection.substrate,
        timeoutMs: opts.timeout * 1000,
      });
      const body = renderReviewBody(result.verdict, selection.substrate.displayName);
      console.log(body);
      console.error(`[sage] verdict: ${result.verdict.decision} (posted=${result.posted})`);
      if (result.verdict.decision === "changes-requested") {
        process.exit(1);
      }
    },
  );

program
  .command("serve")
  .description("Run the bus listener. Subscribes to Myelin code-review tasks and processes them.")
  .option("--nats <url>", "NATS broker URL", process.env.NATS_URL ?? "nats://localhost:4222")
  .option("--org <org>", "Org segment", process.env.SAGE_ORG ?? "metafactory")
  .option("--source <src>", "Envelope source", process.env.SAGE_SOURCE ?? "metafactory.sage.local")
  .option("--did <did>", "Sage's DID", process.env.SAGE_DID ?? "did:mf:sage")
  .option(
    "--substrate <name>",
    "Coding harness Sage runs through ({pi|claude|codex}). Falls back to SAGE_SUBSTRATE / config / pi.",
  )
  .option("--no-post", "Do not post reviews back to GitHub (dry-run)")
  .option(
    "--max-concurrent <n>",
    "Max concurrent reviews (default 3)",
    (v) => parseInt(v, 10),
    Number(process.env.SAGE_MAX_CONCURRENT ?? 3),
  )
  .option("--creds <file>", "NATS .creds file", process.env.NATS_CREDS_FILE)
  .option("--queue <name>", "NATS queue-group for competing-consumer", "sage-review")
  .option(
    "--residency <code>",
    "Data-residency ISO 3166 alpha-2 code stamped on outbound envelopes",
    process.env.MYELIN_DATA_RESIDENCY ?? process.env.SAGE_DATA_RESIDENCY,
  )
  .action(
    async (opts: {
      nats: string;
      org: string;
      source: string;
      did: string;
      post: boolean;
      maxConcurrent: number;
      creds?: string;
      queue: string;
      substrate?: string;
      residency?: string;
    }) => {
      const selection = selectSubstrate({ flag: opts.substrate });
      console.error(
        `[sage] serve — connecting to ${opts.nats} as ${opts.did} on ${selection.substrate.displayName} (${selection.source})`,
      );

      const requireNatsAuth = requiresNatsAuth();

      const bridge = await startBridge({
        natsUrl: opts.nats,
        org: opts.org,
        source: opts.source,
        did: opts.did,
        substrate: selection.substrate,
        postReviews: opts.post,
        maxConcurrentTasks: opts.maxConcurrent,
        ...(opts.creds ? { credsFile: opts.creds } : {}),
        queueGroup: opts.queue,
        ...(opts.residency ? { dataResidency: opts.residency } : {}),
        ...(requireNatsAuth ? { requireNatsAuth: true } : {}),
      });

      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) {
          console.error(`[sage] ${signal} received while already draining — ignoring`);
          return;
        }
        shuttingDown = true;
        console.error(`[sage] received ${signal}, draining...`);
        // Deregister handlers so a second signal can't re-enter even if the
        // shuttingDown check is somehow bypassed. A third signal (or a
        // truly-stuck drain) gets default kill behavior, which is what
        // an impatient operator actually wants at that point.
        process.removeAllListeners("SIGINT");
        process.removeAllListeners("SIGTERM");
        await bridge.close();
        process.exit(0);
      };
      const onSignal = (signal: string) => () => {
        shutdown(signal).catch((err: unknown) => {
          const m = err instanceof Error ? err.stack ?? err.message : String(err);
          console.error(`[sage] shutdown failed during ${signal}: ${m}`);
          // Force exit so the OS supervisor can restart cleanly rather than
          // leaving a hung process.
          process.exit(1);
        });
      };
      process.on("SIGINT", onSignal("SIGINT"));
      process.on("SIGTERM", onSignal("SIGTERM"));
      await bridge.connection.closed();
    },
  );

program
  .command("dispatch")
  .description(
    "Publish a code-review task envelope to the Myelin bus and stream the verdict back. Requires a running Sage daemon (sage serve).",
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
      },
    ) => {
      const requireNatsAuth = requiresNatsAuth();

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
