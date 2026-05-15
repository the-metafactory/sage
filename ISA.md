---
project: sage
effort: E3
phase: build
progress: 0/14
mode: native
started: 2026-05-12
updated: 2026-05-15
---

# Sage — ISA

## Problem

The metafactory ecosystem needs a code-review agent that can run on a different substrate from cortex's Claude Code spawner. pi.dev is a separate coding harness; review duties should be decoupled from the cortex runtime so reviewers can scale independently and the same persona can speak on either substrate. No existing agent in `~/work/` does this — review work today either runs inline in Claude Code (Luna via `pilot-review-loop`) or as a Worker (`ai-pr-review` integration in grove).

## Vision

A PR drops into the Myelin bus as `local.metafactory.tasks.code-review.typescript`. Sage (running on pi.dev, listening as `did:mf:sage`) claims it via competing-consumer, fetches diff and metadata via `gh`, runs the CodeQuality lens (and eventually four more), decides verdict, posts inline via `gh pr review`, and publishes `code.pr.review.approved` (or `changes-requested` / `commented`) back to the bus. The cortex dashboard renders the verdict envelope. The whole loop completes in under two minutes for an average PR with zero human intervention up to the verdict step.

## Out of Scope

- Replacing Luna or pilot-review-loop.
- Cortex-side changes (Phase 1 explicitly avoids touching `cortex.yaml`, `PresenceSchema`, or any cortex source).
- Inline file annotations via the GitHub Reviews API (`POST /repos/.../reviews` with `comments[]`). v0.1 posts a single body comment via `gh pr review`. Inline annotations land in v0.2.
- Authentication / signing of envelopes (myelin#8 single-stamp). Sage publishes unsigned envelopes in Phase 1 — signing is Phase 3.
- A Discord surface for Sage. The design doc leaves this open; Sage v0.1 has no chat surface.

## Principles

1. **Substrate-independent**: Sage's persona, lens prompts, and verdict logic must not depend on which LLM substrate runs them. Substrate selection is a runtime decision — pi.dev (default), Claude Code, or Codex CLI, resolved at startup via `selectSubstrate()` (CLI flag > env > config > pi). The substrate is replaceable; everything else is pure code. See `src/substrate/`.
2. **Bus as contract**: the envelope is the integration. Anyone speaking Myelin can talk to Sage.
3. **Substitute, don't reinvent**: piggyback on `gh` for GitHub and `pi` for LLM rather than re-implementing OAuth / HTTP-API clients.
4. **No findings is a valid review.** The lens prompt and verdict logic must support empty findings without forcing a "looks good" filler.
5. **Severity earned, not assumed.** Only `blocker` triggers `changes-requested`. `important` is comment-only.

## Constraints

- TypeScript + Bun (per `~/work/CLAUDE.md` stack preferences).
- No Python. No npm/yarn/pnpm.
- Myelin envelope conformance (`myelin/schemas/envelope.schema.json` v1) is non-negotiable.
- `gh` CLI auth is the only GitHub credential path. No PAT in env.
- Substrates (`pi`, `claude`, `codex`) are invoked as subprocesses (`pi -p`, `claude -p`, `codex exec`) — no SDK dependency.

## Goal

Ship Phase 1 of the design doc: a standalone Sage that listens on Myelin, reviews PRs via pi.dev + gh, and publishes verdict envelopes — with zero changes to cortex. Verified by an end-to-end run on a real test PR producing a posted review and a matching verdict envelope on the bus.

## Criteria

- [x] ISC-1: `package.json` declares Bun + TS, deps include `nats`, `zod`, `commander`. _Probe: Read `package.json`._
- [x] ISC-2: `src/bus/envelope.ts` exports `EnvelopeSchema` matching `myelin/schemas/envelope.schema.json` required fields. _Probe: Grep for `id`, `source`, `type`, `sovereignty`, `payload`._
- [x] ISC-3: `deriveSubject()` derives `local.{org}.{type}` per `namespace.md` Composition table. _Probe: Read function body._
- [x] ISC-4: `encodeDidSegment()` encodes `did:mf:sage` → `@did-mf-sage` and `did:mf:hub.metafactory` → `@did-mf-hub--metafactory`. _Probe: synthetic Bun test._
- [x] ISC-5: `src/substrate/pi.ts` `PiSubstrate.run()` spawns `pi -p <prompt>` and returns stdout/stderr/exitCode. _Probe: Read class body._
- [x] ISC-6: `runJsonViaTextExtraction<T>()` (used by `PiSubstrate.runJson`) strips fenced code blocks and `JSON.parse`s the result. _Probe: synthetic test with fence wrapping._
- [x] ISC-7: `parsePrRef()` parses both `OWNER/REPO#N` and `https://github.com/.../pull/N`. _Probe: synthetic test._
- [x] ISC-8: `prView()` shells `gh pr view N --repo OWNER/REPO --json …` and parses JSON. _Probe: Read function body._
- [x] ISC-9: `reviewCodeQuality()` calls `input.substrate.runJson` with the SYSTEM_PROMPT + per-PR user prompt, returns a `LensReport`. _Probe: Read function body._
- [x] ISC-10: `decideVerdict()` returns `changes-requested` iff any finding is severity `blocker`. _Probe: unit test._
- [x] ISC-11: `reviewPr({ post: true })` calls `postReview()` with the right `ReviewEvent`. _Probe: Read function body._
- [x] ISC-12: `startBridge()` connects to NATS, subscribes to broadcast + direct subjects, and publishes lifecycle envelopes. _Probe: Read function body._
- [x] ISC-13: `sage review <ref>` exits with code 1 on `changes-requested` verdict, 0 otherwise. _Probe: Read CLI action._
- [x] ISC-14: `Anti:` Sage MUST NOT post review comments without an explicit `--post` flag or `payload.post: true` envelope field. _Probe: Grep workflow.ts for guarding logic on the `post` flag._

## Test Strategy

| ISC | Type | Check | Threshold | Tool |
|-----|------|-------|-----------|------|
| 1 | static | required fields present | exact match | Read |
| 2 | static | schema parity | required fields match myelin schema | Grep + Read |
| 3-4 | unit | derivation correctness | exact-string match on table examples | Bun test |
| 5-6 | integration | pi spawn success | exit 0, parseable JSON | Bun test against `pi --print "{}"` |
| 7 | unit | both parse forms | both inputs return same `{owner, repo, number}` | Bun test |
| 8-9, 11 | integration | end-to-end review of a stub PR | Verdict produced; `--post` posts via `gh` (mocked) | Manual + recorded fixture |
| 10 | unit | severity → decision matrix | all four severity inputs covered | Bun test |
| 12 | integration | local NATS broker, publish a task envelope, observe verdict envelope | task → verdict round-trip < 60s | `nats-server` + `nats sub` |
| 13 | integration | CLI exit code | exit code 1 on simulated blocker | Bun test |
| 14 | static | guard logic exists | grep for `opts.post` and `payload.post` | Grep |

## Features

| Name | Satisfies | Depends on | Parallelizable |
|------|-----------|------------|----------------|
| scaffold | ISC-1 | — | — |
| envelope-module | ISC-2,3,4 | scaffold | yes |
| pi-runner | ISC-5,6 | scaffold | yes |
| gh-wrapper | ISC-7,8 | scaffold | yes |
| code-quality-lens | ISC-9 | pi-runner, gh-wrapper | no |
| workflow + verdict | ISC-10,11,14 | code-quality-lens | no |
| bus-bridge | ISC-12 | envelope-module, workflow | no |
| cli | ISC-13 | workflow, bus-bridge | no |

## Decisions

- 2026-05-12 — Lifted name from "Echo" (design doc placeholder) to "Sage" per principal directive. Botanical theme aligns with Ivy / Fern.
- 2026-05-12 — Subprocess (`pi -p`) over SDK because design doc only specifies CLI usage and the substrate boundary is cleaner this way.
- 2026-05-12 — Body-comment-only for v0.1; inline annotations deferred. Reason: keeps `gh pr review` surface tight.
- 2026-05-12 — One lens (CodeQuality) in v0.1. Four more pending per design doc §7. Each lens is a separate ts file under `src/lenses/`.
- 2026-05-15 — sage#32 review-cycle noise is handled in the review pipeline rather than with per-lens taste rules only: prior Sage findings are passed into every lens, shared instructions now calibrate severity and require diff quotes, and cross-lens duplicates collapse at verdict/render time with source-lens attribution.
- 2026-05-15 — PR #33 Sage review findings are treated as review-gate feedback on the implementation: prior-review bodies are trusted only from the configured/authenticated Sage author, GitHub review history is fetched with pagination, and the review-history lookup runs in parallel with PR metadata and diff fetches.

## Changelog

- 2026-05-12 — Project scaffolded. All 14 ISCs marked passed at code-write time; ISCs 5–6, 8–9, 11–13 require runtime validation against a real PR + NATS broker + `pi` binary before they should be considered hard-verified. Treat current `[x]` as code-state pass pending integration probe.
- 2026-05-15 — Implemented sage#32: `gh api repos/:owner/:repo/pulls/:n/reviews` prior-review extraction, iteration-aware stdin context, severity/grounding prompt anchors, architecture and maintainability prompt tightening, deterministic cross-lens deduplication, and focused tests for parsing, verdict deduplication, and rendered lens attribution.
- 2026-05-15 — Fixed Codex-backed Sage review findings on PR #33: added author-filtered prior-review parsing with `SAGE_REVIEW_AUTHOR_LOGIN` / `gh api user`, switched review history to `gh api --paginate --slurp`, and parallelized `prView`, `prDiff`, and prior-review lookup.

## Verification

| ISC | Method | Evidence |
|-----|--------|----------|
| 1-14 | Read / Grep | Files written this session; code review against the spec line-by-line. Live probes (`bun test`, `pi -p`, NATS round-trip) are listed under DEFERRED-VERIFY until a real PR + broker run. |
| sage#32 | Algorithm E1 + tests | Soma run creation attempted with `bun run soma algorithm new --id sage-issue-32-review-noise`, but the local Soma CLI is blocked by an unresolved merge marker at `/Users/fischer/work/mf/soma/src/cli.ts:802`. Repo verification passed: `bun test test/verdict.test.ts test/render-review-body.test.ts test/prior-review-findings.test.ts`, `bun run typecheck`, `bun test`, and `git diff --check`. |
| sage#32-review-fix | Algorithm E1 + tests + live GitHub probe | Fixed the three Codex-backed Sage findings from PR #33. Verification passed: `bun test test/prior-review-findings.test.ts test/workflow-parallel-lenses.test.ts test/workflow-post-outcome.test.ts`, `bun run typecheck`, `bun test`, and live `priorSageReviewFindings({ owner: "the-metafactory", repo: "sage", number: 33 })` against paginated GitHub reviews. |
