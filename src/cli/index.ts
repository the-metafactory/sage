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
  .action(async (prRef: string, opts: { post: boolean }) => {
    const ref = parsePrRef(prRef);
    const auth = await ghAuthStatus();
    if (!auth.ok) {
      console.error("gh auth is not configured. Run `gh auth login` first.");
      console.error(auth.output);
      process.exit(2);
    }

    console.error(`[sage] reviewing ${ref.owner}/${ref.repo}#${ref.number}`);
    const result = await reviewPr({ ref, post: opts.post });
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
  .action(
    async (opts: { nats: string; org: string; source: string; did: string; post: boolean }) => {
      console.error(`[sage] serve — connecting to ${opts.nats} as ${opts.did}`);
      const bridge = await startBridge({
        natsUrl: opts.nats,
        org: opts.org,
        source: opts.source,
        did: opts.did,
        postReviews: opts.post,
      });

      const shutdown = async (signal: string) => {
        console.error(`[sage] received ${signal}, draining...`);
        await bridge.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
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

    if (existsSync(piSettings) && !opts.force) {
      console.error(`refusing to overwrite ${piSettings} (use --force)`);
    } else {
      writeFileSync(
        piSettings,
        JSON.stringify(
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
        ),
      );
      console.error(`wrote ${piSettings}`);
    }

    if (existsSync(envFile) && !opts.force) {
      console.error(`refusing to overwrite ${envFile} (use --force)`);
    } else {
      writeFileSync(
        envFile,
        [
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
        ].join("\n"),
      );
      console.error(`wrote ${envFile}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const m = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[sage] error: ${m}`);
  process.exit(1);
});
