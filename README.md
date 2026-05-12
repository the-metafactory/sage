# Sage

> Botanical-named code review agent on the pi.dev substrate. Speaks Myelin envelopes. Posts via `gh`.

Sage reviews GitHub pull requests through composable lenses (CodeQuality first; Security, Architecture, EcosystemCompliance, Performance to follow) and publishes verdicts as Myelin envelopes for the cortex dashboard, pilot loop, and any other consumer to render.

**Phase 1 standalone** — no cortex changes required.

## Design reference

`~/work/mf/cortex/docs/design-pi-dev-review-agent.md` — the architecture this implements.

## Install

```bash
cd ~/work/sage
bun install
cp .env.example .env
```

Prerequisites:

- [`bun`](https://bun.sh/) >= 1.1
- [`gh`](https://cli.github.com/) authenticated (`gh auth status` green)
- [`pi`](https://pi.dev/docs/latest/usage) installed and on `$PATH` (`npm i -g @earendil-works/pi-coding-agent`)
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

Subscribes to:

- `local.{org}.tasks.code-review.>` (broadcast — competing consumer)
- `local.{org}.tasks.@did-mf-sage.>` (direct — named recipient)

Publishes:

- `local.{org}.dispatch.task.{started,progress,completed,failed}`
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
| `src/pi/runner.ts` | `pi -p` subprocess wrapper, `runPiJson<T>()` |
| `src/pi/env.ts` | `buildPiEnv()` — allow-listed env forwarding to the subprocess |
| `src/github/gh.ts` | `gh pr view/diff/review` wrapper, PR-ref parser |
| `src/lenses/types.ts` | `Finding`, `LensReport`, `decideVerdict()` |
| `src/lenses/code-quality.ts` | The first lens (CodeQuality). |
| `src/lenses/workflow.ts` | Per-PR orchestration: fetch → lenses → verdict → optional post |
| `config/persona.md` | Sage's reviewing voice and principles |
| `ISA.md` | Ideal State Articulation (E3 tier) |

## Provider keys

Sage does **not** call any LLM directly — `pi` does. Provider API keys live in
the parent process env (`.env` for `bun run`, systemd `Environment=` for
daemons) and Sage forwards them to the subprocess through an explicit
allow-list in `src/pi/env.ts`.

Auto-forwarded by default:

- `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`,
  `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `DEEPSEEK_API_KEY`,
  `XAI_API_KEY`, `PERPLEXITY_API_KEY`, `FIREWORKS_API_KEY`
- Azure: `AZURE_API_KEY`, `AZURE_API_BASE`, `AZURE_API_VERSION`
- AWS (Bedrock): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`, `AWS_REGION`
- Any key starting with `PI_` — pi.dev's own configuration namespace
- Shell essentials: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TZ`, …

Adjust without code changes:

```bash
# Forward extra keys
PI_ENV_ALLOW=MY_CUSTOM_TOKEN,REGISTRY_TOKEN sage review …

# Block a default forward
PI_ENV_DENY=OPENAI_API_KEY sage serve …
```

Non-allow-listed env vars are **not** forwarded — keeps daemon secret blast
radius tight when Sage runs under systemd / launchd with a noisy parent env.

## Roadmap (per design doc §10)

- **Phase 1 (this repo):** standalone bus listener + GitHub posting. ✅ scaffolded.
- **Phase 2:** capability registry in NATS KV; cortex dispatch routes by capability.
- **Phase 3:** Broadcast/Direct/Delegate distribution modes, OTLP spans, security hardening.

Additional lenses pending: Security, Architecture, EcosystemCompliance, Performance.

## License

MIT.
