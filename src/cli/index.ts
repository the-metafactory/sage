#!/usr/bin/env bun
import { Command } from "commander";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parsePrRef, ghAuthStatus } from "../github/gh.ts";
import { reviewPr, renderReviewBody } from "../lenses/workflow.ts";
import { startBridge } from "../bus/bridge.ts";

const program = new Command();

program
  .name("sage")
  .description("Sage — botanical code-review agent on pi.dev, speaking Myelin envelopes")
  .version("0.1.0");

program
  .command("review")
  .description("Review a single PR offline (no bus). Prints rendered review to stdout.")
  .argument("<pr-ref>", "PR URL or OWNER/REPO#N")
  .option("--post", "Post the review back to the PR via gh", false)
  .option(
    "--timeout <seconds>",
    "Per-lens pi timeout in seconds (default 600 / 10min)",
    (v) => parseInt(v, 10),
    Number(process.env.SAGE_REVIEW_TIMEOUT ?? 600),
  )
  .action(async (prRef: string, opts: { post: boolean; timeout: number }) => {
    const ref = parsePrRef(prRef);
    const auth = await ghAuthStatus();
    if (!auth.ok) {
      console.error("gh auth is not configured. Run `gh auth login` first.");
      console.error(auth.output);
      process.exit(2);
    }

    console.error(
      `[sage] reviewing ${ref.owner}/${ref.repo}#${ref.number} (timeout=${opts.timeout}s)`,
    );
    const result = await reviewPr({
      ref,
      post: opts.post,
      timeoutMs: opts.timeout * 1000,
    });
    const body = renderReviewBody(result.verdict);
    console.log(body);
    console.error(`[sage] verdict: ${result.verdict.decision} (posted=${result.posted})`);
    if (result.verdict.decision === "changes-requested") {
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Run the bus listener. Subscribes to Myelin code-review tasks and processes them.")
  .option("--nats <url>", "NATS broker URL", process.env.NATS_URL ?? "nats://localhost:4222")
  .option("--org <org>", "Org segment", process.env.SAGE_ORG ?? "metafactory")
  .option("--source <src>", "Envelope source", process.env.SAGE_SOURCE ?? "metafactory.sage.local")
  .option("--did <did>", "Sage's DID", process.env.SAGE_DID ?? "did:mf:sage")
  .option("--no-post", "Do not post reviews back to GitHub (dry-run)")
  .option(
    "--max-concurrent <n>",
    "Max concurrent reviews (default 3)",
    (v) => parseInt(v, 10),
    Number(process.env.SAGE_MAX_CONCURRENT ?? 3),
  )
  .option("--creds <file>", "NATS .creds file", process.env.NATS_CREDS_FILE)
  .option("--queue <name>", "NATS queue-group for competing-consumer", "sage-review")
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
    }) => {
      console.error(`[sage] serve — connecting to ${opts.nats} as ${opts.did}`);
      const bridge = await startBridge({
        natsUrl: opts.nats,
        org: opts.org,
        source: opts.source,
        did: opts.did,
        postReviews: opts.post,
        maxConcurrentTasks: opts.maxConcurrent,
        ...(opts.creds ? { credsFile: opts.creds } : {}),
        queueGroup: opts.queue,
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
  .command("init")
  .description("Write pi.settings.json and .env templates into the current directory.")
  .option("--force", "Overwrite existing files", false)
  .action((opts: { force: boolean }) => {
    const cwd = process.cwd();
    const piSettings = join(cwd, "pi.settings.json");
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

    const envContent = [
      "NATS_URL=nats://localhost:4222",
      "SAGE_AGENT_ID=sage",
      "SAGE_DID=did:mf:sage",
      "SAGE_SOURCE=metafactory.sage.local",
      "SAGE_ORG=metafactory",
      "SAGE_DATA_RESIDENCY=CH",
      "PI_BIN=pi",
      "PI_PROVIDER=anthropic",
      "PI_MODEL=anthropic/claude-sonnet-4-6",
      "",
    ].join("\n");

    const writes: Array<{ path: string; content: string }> = [
      { path: piSettings, content: piSettingsContent },
      { path: envFile, content: envContent },
    ];

    // Pre-flight all conflicts so init fails atomically — no half-written
    // state where one file is created and the other is refused.
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
