# Sage

> Botanical-named code review agent. Runs on pi.dev (default) or Claude Code via the `--substrate` flag. Speaks Myelin envelopes. Posts via `gh`.

Sage reviews GitHub pull requests through composable lenses (CodeQuality first; Security, Architecture, EcosystemCompliance, Performance to follow) and publishes verdicts as Myelin envelopes for the cortex dashboard, pilot loop, and any other consumer to render.

**Phase 1 standalone** — no cortex changes required.

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
3. Renders `agent.yaml` into `~/.config/cortex/agents.d/sage.yaml` (identity + trust + capabilities)
4. Signals cortex to reload (`cortex agents reload` or SIGHUP fallback)
5. Mints sage's NATS credentials (`cortex creds issue sage`) scoped to the declared `runtime.capabilities`
6. Installs the launchd plist to `~/Library/LaunchAgents/ai.meta-factory.sage.plist`
7. `launchctl bootstrap`s the daemon — it connects the bus, registers capabilities in NATS KV, and starts claiming review tasks

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
- NATS broker reachable at `$NATS_URL` for `serve` mode (optional for `review` mode)

## Usage

### Offline review — no bus required

```bash
bun run src/cli/index.ts review the-metafactory/cortex#58
# or
bun run src/cli/index.ts review https://github.com/the-metafactory/cortex/pull/58 --post
```

Without `--post` Sage renders the review to stdout. With `--post`, Sage submits via `gh pr review`.

### Bus listener

```bash
bun run src/cli/index.ts serve --nats nats://localhost:4222 --org metafactory
```

### NATS-driven dispatch (with a running daemon)

```bash
bun run src/cli/index.ts dispatch the-metafactory/sage#1
```

Publishes a `tasks.code-review.typescript` envelope and streams the
`dispatch.task.*` lifecycle + `code.pr.review.*` verdict back. Exits 0 on
`completed`, 1 on `failed`, 2 on timeout. Pass `--post` to ask the receiver
to post the review to GitHub via `gh`. Pass `--wait 1200` to bump the cap.

Subscribes to:

- `local.{org}.tasks.code-review.>` (broadcast — competing consumer)
- `local.{org}.tasks.@did-mf-sage.>` (direct — named recipient)

Publishes:

- `local.{org}.dispatch.task.{started,progress,completed,failed,post-failed}`
  - `post-failed` (sage#16): lens work succeeded but the `gh pr review` call threw. Verdict is on disk at `~/.config/sage/reviews/<owner>-<repo>-<n>.{json,md}`; the envelope payload carries the original `verdict` plus a structured `error: { message }`. Sibling of `failed` in the lifecycle namespace because it describes what happened to the message, not the message itself.
- `local.{org}.code.pr.review.{approved,changes-requested,commented}`

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
              local.{org}.tasks.code-review.>│  local.{org}.tasks.@did-mf-sage.>
                                             ▼
            ┌───────────────────────────────────────────────────┐
            │                    src/bus/bridge.ts              │
            │      validate envelope → dispatch.task.started    │
            └────────────────────────┬──────────────────────────┘
                                     │
                                     ▼
            ┌───────────────────────────────────────────────────┐
            │           src/lenses/workflow.ts                  │
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
              local.{org}.code.pr.review.{approved|…}
              local.{org}.dispatch.task.completed
```

## Module map

| Path | Purpose |
|------|---------|
| `src/cli/index.ts` | `sage review`, `sage serve`, `sage init` |
| `src/bus/envelope.ts` | Zod mirror of `myelin/schemas/envelope.schema.json` + `buildEnvelope`, `deriveSubject` |
| `src/bus/subjects.ts` | Subject helpers (broadcast / direct / dispatch / verdict) |
| `src/bus/bridge.ts` | NATS connect, subscribe, dispatch, publish |
| `src/substrate/types.ts` | `Substrate` interface — substrate-neutral surface every coding harness implements |
| `src/substrate/base.ts` | `runJsonViaTextExtraction` — forgiving JSON extractor reused by substrates without native structured output |
| `src/substrate/env.ts` | `buildSubstrateEnv()` — allow-listed env forwarding with PI_*/CLAUDE_*/ANTHROPIC_* namespaces |
| `src/substrate/pi.ts` | `PiSubstrate` — wraps `pi -p` |
| `src/substrate/claude.ts` | `ClaudeSubstrate` — wraps `claude -p` with native `--output-format json` |
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

Sage runs the lens prompts through one of two coding-harness subprocesses.
Selection is daemon-level — resolved once at startup, applied to every task
this process handles:

1. CLI `--substrate {pi|claude}` flag (on `sage review` / `sage serve`)
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

## Provider keys

Sage does **not** call any LLM directly — the substrate does. Provider API
keys live in the parent process env (`.env` for `bun run`, systemd
`Environment=` for daemons) and Sage forwards them to the subprocess
through an explicit allow-list in `src/substrate/env.ts`.

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
  `CLAUDE_*` and `ANTHROPIC_*` (forwarded only when substrate=claude)
- Shell essentials: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TZ`, …

Adjust without code changes:

```bash
# Forward extra keys
SAGE_ENV_ALLOW=MY_CUSTOM_TOKEN,REGISTRY_TOKEN sage review …

# Block a default forward
SAGE_ENV_DENY=OPENAI_API_KEY sage serve …
```

Legacy `PI_ENV_ALLOW` / `PI_ENV_DENY` are still honored for back-compat —
operators don't need to migrate. Non-allow-listed env vars are **not**
forwarded; keeps daemon secret blast radius tight when Sage runs under
systemd / launchd with a noisy parent env.

## Roadmap (per design doc §10)

- **Phase 1 (this repo):** standalone bus listener + GitHub posting. ✅ scaffolded.
- **Phase 2:** capability registry in NATS KV; cortex dispatch routes by capability.
- **Phase 3:** Broadcast/Direct/Delegate distribution modes, OTLP spans, security hardening.

Additional lenses pending: Security, Architecture, EcosystemCompliance, Performance.

## License

MIT.
