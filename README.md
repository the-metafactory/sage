# Sage

> Botanical-named code review agent. Runs on pi.dev (default), Claude Code, or Codex CLI via the `--substrate` flag. Speaks Myelin envelopes. Posts via `gh`.

Sage reviews GitHub pull requests through composable lenses (CodeQuality first; Security, Architecture, EcosystemCompliance, Performance to follow) and publishes verdicts as Myelin envelopes for the cortex dashboard, pilot loop, and any other consumer to render.

**In-process inside cortex** (sage#40). Cortex's `ReviewConsumer` owns the NATS subscribe loop, queue-group, ack/nak, redelivery, signature verification (D1), and lifecycle envelope emission. Sage exposes its review pipeline (`reviewPr` in `src/lenses/workflow.ts`) as the `pipelineRunner` cortex injects into the consumer. One cortex process owns every reviewer agent (sage, fern, future); one PID, one log stream, one restart semantics.

## Design reference

`~/work/mf/cortex/docs/design-pi-dev-review-agent.md` — the architecture this implements.

## Install

### Via arc (recommended)

Once cortex is running and `arc` is on PATH:

```bash
arc install github:the-metafactory/sage
```

This single command:

1. Clones sage to `~/.config/metafactory/pkg/repos/sage/`
2. Drops `persona.md` into `~/.config/cortex/personas/sage.md`
3. Renders `sage.md` into `~/.config/cortex/agents.d/sage.md` (identity + trust + per-flavor `code-review.*` capabilities)
4. Signals cortex to reload — cortex reads `agents.d/sage.md`, wires sage's review pipeline as the in-process `pipelineRunner` for its `ReviewConsumer`, and starts subscribing to `tasks.code-review.*` for the declared flavors
5. Mints sage's NATS credentials (`cortex creds issue sage`) scoped to the declared `runtime.capabilities`

There is no separate launchd plist, no `~/Library/LaunchAgents/ai.meta-factory.sage.plist`, no daemon to start. Cortex is the one process that owns sage's subscription and lifecycle (sage#40).

See `arc-manifest.yaml` for the full spec and `scripts/` for the lifecycle hooks. Architecture context: `cortex/docs/design-arc-agent-bots.md` §3.2.

### Manual (for development)

```bash
cd ~/work/sage
bun install
cp .env.example .env
```

Prerequisites:

- [`bun`](https://bun.sh/) >= 1.1
- [`gh`](https://cli.github.com/) authenticated (`gh auth status` green)
- One of the supported substrates on `$PATH`:
  - [`pi`](https://pi.dev/docs/latest/usage) (default) — `npm i -g @earendil-works/pi-coding-agent`
  - [`claude`](https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview) — for `--substrate claude`
  - `codex` CLI — for `--substrate codex`
- A running cortex process if you want bus-driven dispatch (cortex hosts sage's in-process consumer). `review` mode does not need NATS or cortex.

## Usage

### Offline review — no bus required

```bash
bun run src/cli/index.ts review the-metafactory/cortex#58
# or
bun run src/cli/index.ts review https://github.com/the-metafactory/cortex/pull/58 --post
```

Without `--post` Sage renders the review to stdout. With `--post`, Sage submits via `gh pr review`.

### Bus listener

Sage no longer runs its own bus listener. Cortex's `ReviewConsumer`
subscribes to the code-review subjects and invokes sage's review pipeline
as an in-process `pipelineRunner` (sage#40). Start cortex; sage's
subscription comes up with it.

### NATS-driven dispatch (with a running cortex hosting sage)

```bash
bun run src/cli/index.ts dispatch the-metafactory/sage#1
```

Publishes a `tasks.code-review.typescript` envelope and streams the
`dispatch.task.*` lifecycle + `code.pr.review.*` verdict back. Exits 0 on
`completed`, 1 on `failed`, 2 on timeout. Pass `--post` to ask the receiver
to post the review to GitHub via `gh`. Pass `--wait 1200` to bump the cap.

The receiving cortex's `ReviewConsumer` subscribes to (per declared sage flavors):

- `local.{org}.{stack}.tasks.code-review.<flavor>` (broadcast — competing consumer; flavors from `runtime.capabilities`)
- `local.{org}.{stack}.tasks.@did-mf-sage.>` (direct — named recipient)

And publishes:

- `local.{org}.{stack}.dispatch.task.{started,progress,completed,failed,post-failed}`
  - `post-failed` (sage#16): lens work succeeded but the `gh pr review` call threw. Verdict is on disk at `~/.config/sage/reviews/<owner>-<repo>-<n>.{json,md}`; the envelope payload carries the original `verdict` plus a structured `error: { message }`. Sibling of `failed` in the lifecycle namespace because it describes what happened to the message, not the message itself.
- `local.{org}.{stack}.code.pr.review.{approved,changes-requested,commented}`

### Task envelope payload

```json
{
  "id": "<uuid>",
  "source": "metafactory.cortex.dispatch",
  "type": "tasks.code-review.typescript",
  "timestamp": "2026-05-12T12:00:00Z",
  "sovereignty": {
    "classification": "local",
    "data_residency": "CH",
    "max_hop": 0,
    "frontier_ok": true,
    "model_class": "any"
  },
  "payload": {
    "pr_url": "https://github.com/the-metafactory/cortex/pull/58",
    "post": true
  }
}
```

Either `pr_url` or `(owner, repo, number)` is required. `post` defaults to `cfg.postReviews`.

## Architecture

```
                                ┌───────────────────────────┐
                                │      NATS (Myelin bus)    │
                                └────────────┬──────────────┘
                                             │
       local.{org}.{stack}.tasks.code-review.<flavor>      local.{org}.{stack}.tasks.@did-mf-sage.>
                                             ▼
            ┌───────────────────────────────────────────────────┐
            │   cortex ReviewConsumer (cortex#237)              │
            │   subscribe + ack/nak + lifecycle envelopes       │
            │   D1 signature verification on inbound            │
            │   ─── invokes injected pipelineRunner ───►        │
            └────────────────────────┬──────────────────────────┘
                                     │
                                     ▼
            ┌───────────────────────────────────────────────────┐
            │           sage/src/lenses/workflow.ts             │
            │                  reviewPr(opts)                   │
            │  ┌─────────────────────────────────────────────┐  │
            │  │  gh pr view + gh pr diff  →  PrMetadata     │  │
            │  └──────┬──────────────────────────────────────┘  │
            │         │                                         │
            │         ▼                                         │
            │  ┌─────────────────────────────────────────────┐  │
            │  │  CodeQuality lens  →  pi -p (JSON output)   │  │
            │  └──────┬──────────────────────────────────────┘  │
            │         │  (Security, Architecture, … to follow)  │
            │         ▼                                         │
            │  decideVerdict → gh pr review --comment/approve   │
            └────────────────────────┬──────────────────────────┘
                                     │
                                     ▼
              local.{org}.{stack}.code.pr.review.{approved|…}
              local.{org}.{stack}.dispatch.task.completed
```

## Module map

| Path | Purpose |
|------|---------|
| `src/cli/index.ts` | `sage review`, `sage dispatch`, `sage init` |
| `src/bus/connect.ts` | Shared NATS connect helper used by `sage dispatch` |
| `src/bus/dispatcher.ts` | `sage dispatch` — bus-side publisher half (cortex's `ReviewConsumer` is the receiver) |
| `src/bus/emit.ts` | Outbound envelope emitter |
| `src/lenses/workflow.ts` | `reviewPr` — the entry point cortex invokes as the in-process `pipelineRunner` |
| `src/substrate/types.ts` | `Substrate` interface — substrate-neutral surface every coding harness implements |
| `src/substrate/spawn.ts` | Shared subprocess helpers for substrate wrappers |
| `src/substrate/json.ts` | `runJsonViaTextExtraction` — forgiving JSON extractor reused by substrates without native structured output |
| `src/substrate/env.ts` | `buildSubstrateEnv()` — allow-listed env forwarding with PI_*/CLAUDE_*/ANTHROPIC_*/CODEX_* namespaces |
| `src/substrate/pi.ts` | `PiSubstrate` — wraps `pi -p` |
| `src/substrate/claude.ts` | `ClaudeSubstrate` — wraps `claude -p` with native `--output-format json` |
| `src/substrate/codex.ts` | `CodexSubstrate` — wraps `codex exec` |
| `src/substrate/select.ts` | `selectSubstrate()` — flag > env > config > pi resolution |
| `src/github/gh.ts` | `gh pr view/diff/review` wrapper, PR-ref parser |
| `src/lenses/types.ts` | `Finding`, `LensReport`, `decideVerdict()` |
| `src/lenses/base.ts` | Shared lens scaffolding (`runLens`, prompt template) |
| `src/lenses/applicability.ts` | Trigger heuristics for conditional lenses |
| `src/lenses/code-quality.ts` | CodeQuality lens (always fires) |
| `src/lenses/security.ts` | Security lens — fires on auth/input/secret/crypto signals |
| `src/lenses/architecture.ts` | Architecture lens — fires on new modules / schema / dep changes |
| `src/lenses/ecosystem-compliance.ts` | EcosystemCompliance lens — fires on cortex.yaml / arc-manifest / hooks / SKILL.md |
| `src/lenses/performance.ts` | Performance lens — fires on hot-path / sync-IO / N+1 signals |
| `src/cli/dispatch.ts` | `sage dispatch` — bus-driven review trigger |
| `src/lenses/workflow.ts` | Per-PR orchestration: fetch → lenses → verdict → optional post |
| `persona.md` | Sage's reviewing voice and principles (root copy shipped by arc) |
| `ISA.md` | Ideal State Articulation (E3 tier) |

## Substrate selection

Sage runs the lens prompts through one of three coding-harness subprocesses.
Selection is process-level — resolved once when the host (cortex, in-process,
or the `sage review` CLI standalone) starts up, and applied to every task
this process handles:

1. CLI `--substrate {pi|claude|codex}` flag (on `sage review`)
2. Env `SAGE_SUBSTRATE`
3. Config file `~/.config/sage/config.json` → `substrate.default`
4. Built-in default: `pi` (preserves pre-#14 behavior)

Per-task substrate selection is deliberately not supported (see issue #14
"Out of scope") — same persona on different substrates should produce
envelopes that differ ONLY in `extensions.substrate`, which makes A/B
comparison trivial without diluting verdict reproducibility.

| Substrate | Binary | Native JSON | Notes |
|-----------|--------|-------------|-------|
| `pi` (default) | `pi -p` | text-extraction | Honors `--provider`, `--model`, `--api-key`, `--tools`, `--thinking` |
| `claude` | `claude -p` | `--output-format json` | Reads `CLAUDE_MODEL`, `CLAUDE_PERMISSION_MODE` (default `acceptEdits` for daemons) |
| `codex` | `codex exec` | text-extraction | Reads `CODEX_MODEL`, `CODEX_PROFILE`, `CODEX_SANDBOX`; defaults to read-only sandbox + no approvals |

## Provider keys

Sage does **not** call any LLM directly — the substrate does. Provider API
keys live in the parent process env (`.env` for `bun run`, the host cortex
process env for in-process invocation) and Sage forwards them to the
subprocess through an explicit allow-list in `src/substrate/env.ts`.

Auto-forwarded by default:

- `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  `GROQ_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`,
  `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `PERPLEXITY_API_KEY`,
  `FIREWORKS_API_KEY`, `CEREBRAS_API_KEY`
- Azure: `AZURE_OPENAI_API_KEY`, `AZURE_API_KEY`, `AZURE_API_BASE`, `AZURE_API_VERSION`
- AWS (Bedrock): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`, `AWS_REGION`
- Substrate-scoped namespaces: `PI_*` (forwarded only when substrate=pi);
  `CLAUDE_*` and `ANTHROPIC_*` (forwarded only when substrate=claude);
  `CODEX_*` (forwarded only when substrate=codex)
- Shell essentials: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TZ`, …

Adjust without code changes:

```bash
# Forward extra keys
SAGE_ENV_ALLOW=MY_CUSTOM_TOKEN,REGISTRY_TOKEN sage review …

# Block a default forward
SAGE_ENV_DENY=OPENAI_API_KEY sage review …
```

Legacy `PI_ENV_ALLOW` / `PI_ENV_DENY` are still honored for back-compat —
operators don't need to migrate. Non-allow-listed env vars are **not**
forwarded; keeps the substrate subprocess's secret blast radius tight even
when the host cortex process inherits a noisy parent env.

## Roadmap

- **Phase 1:** standalone bus listener + GitHub posting. ✅ shipped.
- **Phase 2 (sage#40):** in-process under cortex's `ReviewConsumer`; per-flavor `code-review.<flavor>` capabilities; signature verification via D1 inherited from cortex. ✅ this PR.
- **Phase 3:** Broadcast/Direct/Delegate distribution modes, OTLP spans, additional lenses (Security, Architecture, EcosystemCompliance, Performance).

## License

MIT.
