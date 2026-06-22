# Sage — Context

Sage is a code-review **assistant** in the metafactory ecosystem. Hosted in-process by cortex (sage#40), Sage consumes Task envelopes off the bus, runs a pipeline of Lenses against a PR, decides a Verdict, and emits a Verdict envelope back. Persona: botanical, terse, severity earned.

This is the canonical domain glossary for the **sage** bounded context — one canonical term per concept; aliases are listed under _Avoid_. Boundary terms shared with myelin and cortex are reconciled in `compass/ecosystem/CONTEXT-MAP.md`; sage **consumes** their published language and does not redefine it. Resolved by a `grill-with-docs` session.

## Language

### Reviews & verdicts

**Review**:
The *act* of reviewing one PR — full pipeline run from PR fetch → Lens execution → Verdict → optional post. "Sage performs a Review on a PR." The CLI command `sage review <ref>` performs one Review against a single PR. Each Task envelope claimed off the bus triggers exactly one Review.
_Avoid_: review run, review job, scan

**Verdict**:
The *decision* output of a Review — exactly one of `approved`, `changes-requested`, `commented`. Produced by `decideVerdict()`. A Verdict of `changes-requested` is **earned, not assumed**: at least one Finding must have Severity `blocker`. No findings is a valid Verdict (`approved` or `commented` per config).
_Avoid_: result, outcome, status

**Verdict envelope**:
The Envelope carrying a Verdict + supporting Findings back onto the bus. Published with `type: "code.pr.review.{verdict}"`, deriving the Subject `local.{principal}.{stack}.code.pr.review.{approved|changes-requested|commented}`. Distinct from the Review itself and from the Review comment.
_Avoid_: review envelope, verdict message

**Review comment**:
The markdown *body posted to the Forge* — rendered from the Verdict + Findings and submitted via `gh pr review --body` (GitHub) or a GitLab note. The Forge-visible surface of a Review. Comment-only by default; only `--post` (CLI) or `payload.post: true` (envelope) triggers it.
_Avoid_: review body, comment body

**PostAction**:
The *forge call* mapped from a Verdict — `comment`, `approve`, or `request-changes`. Renamed from the codebase's `ReviewEvent` because it is neither an event nor on any event stream; it is a forge-API enum.
_Avoid_: ReviewEvent, review action, review type

### Lenses

**Lens**:
A *concern category* — `CodeQuality`, `Security`, `Architecture`, `ContextDrift`, `EcosystemCompliance`, `Performance`, `Maintainability`. Static: name + prompt + Applicability rule + Finding parser. Lenses are registered, not instantiated per Review. Substrate-independent: a Lens's prompts and parser are the same regardless of which Substrate runs them.
_Avoid_: reviewer, checker, rule, linter, dimension

**Lens run**:
The *per-PR execution* of one Lens. Input: PrMetadata + diff + Prior Findings. Output: a LensReport, or a skip when Applicability returns false for this PR. Lens runs of different Lenses inside one Review execute in parallel.
_Avoid_: lens invocation, lens pass, lens-call

**Finding**:
A single issue raised in one Lens run. Carries Severity, a diff-quoted location (mandatory — anchors the Finding in the change), and source-Lens attribution. Cross-Lens duplicates collapse at Verdict-render time with source-Lens attribution preserved.
_Avoid_: issue, comment, remark, note

**LensReport**:
The *result of one Lens run* — list of Findings plus optional skip reason. The unit a Verdict is decided from.
_Avoid_: lens output, lens result

**Severity**:
One of `blocker`, `important`, `suggestion`, `nit`. Earned, not assumed: only `blocker` flips the Verdict to `changes-requested`. `important` and below are comment-only. Severity is calibrated against Prior Findings — repeating a `nit` across iterations is not a `blocker`.
_Avoid_: priority, level, impact

**Applicability**:
The *static rule* on a Lens deciding whether a Lens run should occur for a given PR. CodeQuality's Applicability is unconditional — it is the always-on Lens. The other Lenses fire on diff signals (auth/secret/crypto for Security; new modules / schema for Architecture; `CONTEXT.md`, docs, domain terms, or public surface vocabulary for ContextDrift; cortex.yaml / arc-manifest / hooks for EcosystemCompliance; hot path / sync IO / N+1 for Performance; file size for Maintainability).
_Avoid_: trigger, condition, gate, filter

**Always-on Lens**:
The Lens whose Applicability is unconditional. Currently exactly one: **CodeQuality**. Every Review produces at least a CodeQuality LensReport.
_Avoid_: default lens, baseline lens

**Prior Findings**:
Findings attributed to Sage from earlier Reviews on the same PR. Fed into every Lens run to calibrate Severity and suppress repeated noise across review iterations. Trust-gated: only Reviews authored by the configured Sage identity count (`SAGE_REVIEW_AUTHOR_LOGIN` / `gh api user`).
_Avoid_: previous findings, history, past comments

### Forges

**Forge**:
The *platform* hosting the PR — GitHub or GitLab. Noun used for the platform itself ("which Forge?", "Forge selection precedence"). Selected per-Review via `--forge`, `SAGE_FORGE`, URL detection, then default `github`.
_Avoid_: provider (that word is taken by LLM Provider), platform, host, SCM

**Forge backend**:
The *concrete adapter* satisfying the Forge interface (`src/forge/types.ts`). One per Forge: `GitHubBackend`, `GitLabBackend`. The "backend" suffix disambiguates the adapter from Forge-as-platform.
_Avoid_: forge client, forge driver, forge impl

**PR**:
The *change-request artifact* on a Forge. Canonical internal term even on GitLab (which calls it Merge Request). User-facing strings translate to the Forge's native vocabulary; everything else uses PR.
_Avoid_: MR, merge request, pull request (spelled-out forms only in user-visible copy)

**PrRef**:
The *parsed reference* to a PR — `{ owner, repo, number, host? }`. Produced by `parsePrRef()`. Routed by URL shape (`github.com`, `/-/merge_requests/`) or shorthand separator (`#` for GitHub, `!` for GitLab).
_Avoid_: PR identifier, PR locator, pr-ref

**PrMetadata**:
The *normalized PR shape* returned by a Forge backend's `prView` — title, state, author, base/head, files-changed. Forge-specific shapes collapsed (e.g. GitLab `state: "opened"` → `"open"`).
_Avoid_: PR info, PR object, MR metadata

**Self-review block**:
The *Forge edge case* where the PR author cannot approve their own PR. Both Forge backends detect it via a narrow forge-specific regex and fall back to `comment`-only PostAction with `downgraded: true`. The regex is deliberately narrow — bare "access denied" is too broad.
_Avoid_: self-approve error, self-approval rejection

### Substrates

**Substrate**:
The *coding-harness subprocess* Sage launches to run an LLM call on its behalf — `pi -p`, `claude -p`, or `codex exec`. The replaceable seam: Sage never calls an LLM directly. Persona, Lens prompts, Verdict logic — everything above the Substrate — is substrate-independent by principle.
_Avoid_: model, LLM, runner, harness (bare)

**Substrate adapter**:
A *concrete impl* of the Substrate interface — `PiSubstrate`, `ClaudeSubstrate`, `CodexSubstrate`. Each wraps one harness binary and absorbs its JSON-extraction quirks.
_Avoid_: substrate client, substrate driver

**Process-level substrate**:
The *binding rule*: Substrate is resolved once at host startup (CLI flag > env > config > pi) and applies to every Review this process handles. Per-task Substrate selection is deliberately out of scope — same Persona on different Substrates must produce envelopes that differ only in `extensions.substrate`, so A/B comparison stays clean.
_Avoid_: per-task substrate (the rejected alternative)

**Persona**:
Sage's *reviewing voice and principles*, captured in `persona.md`. Substrate-independent. Shipped via arc into cortex's personas dir at install (`~/.config/cortex/personas/sage.md`). The Persona file is one input to every Lens's system prompt.
_Avoid_: voice, character, style, identity (that is the cryptographic concept — see boundary section)

**Prompt**:
The *Substrate input* — composed inside a Lens run from a shared system prompt (Persona + lens base instructions) plus a per-PR per-Lens user prompt. Sent through the Substrate, never directly to a Provider.
_Avoid_: query, request, message (those are bus terms)

**Provider**:
The *LLM vendor* behind a Substrate (Anthropic, OpenAI, OpenRouter, Gemini, …). Sage forwards Provider API keys to the Substrate subprocess via an explicit env allow-list (`src/substrate/env.ts`) and never sees Provider responses directly — the Substrate is the only consumer.
_Avoid_: vendor, model provider, API

### Sage-specific bus surfaces

These specialize myelin Envelopes and cortex Subjects for Sage's role. The underlying Envelope schema, Subject grammar, and Dispatch modes are owned by **myelin** and **cortex** respectively — see Boundary section.

**Task envelope**:
A myelin Envelope where `type: "tasks.code-review.{subcapability}"` and `payload: { pr_url?, owner?, repo?, number?, post?, forge? }`. The trigger for a Review when claimed off the bus.
_Avoid_: task message, review task, work item

**Lifecycle envelope**:
A myelin Envelope on the `dispatch.task` domain with `action ∈ {started, progress, completed, failed, post-failed}`. Tracks the Task envelope's fate, not the Review's content. Emitted by cortex's `ReviewConsumer` on Sage's behalf.
_Avoid_: dispatch envelope, status envelope, progress event

**post-failed**:
The Sage-specific Lifecycle action where the Review succeeded but the Forge `postReview` call threw. Verdict envelope still emits; Lifecycle payload carries `error: { message }`. Verdict is persisted at `~/.config/sage/reviews/<owner>-<repo>-<n>.{json,md}` so the Verdict isn't lost when the post fails. Sibling of `failed` because it describes the message's fate, not the Review's.
_Avoid_: review-failed, comment-failed

**Dispatcher**:
Sage's *publisher-side* component (`src/bus/dispatcher.ts`). Builds Task envelopes, publishes them via Offer Dispatch, then streams Lifecycle + Verdict envelopes back to the calling `sage dispatch` CLI. Sage no longer runs its own consumer — cortex's `ReviewConsumer` owns the subscribe loop, ack/nak, signature verification (sage#40).
_Avoid_: publisher, sender, emitter

**Sage's capability declaration**:
The set of `code-review.{subcapability}` Capability tags Sage declares in `arc-manifest.yaml` → `runtime.capabilities`. Drives which Offer Subjects cortex subscribes Sage to. Example: declaring `code-review.typescript` causes cortex to subscribe Sage to `local.{principal}.{stack}.tasks.code-review.typescript`.
_Avoid_: flavor list, capability list (Sage's specifically; bare "capability list" is too generic)

**Direct-address Subject**:
The cortex Direct/Delegate Subject shape applied to Sage: `local.{principal}.{stack}.tasks.@did-mf-sage.>`. `@did-mf-sage` is myelin's DID-encoded form of `did:mf:sage` (per myelin namespace, `:` → `-`, `.` → `--`).
_Avoid_: direct subject, named subject

## Relationships

- A **Review** runs zero or more applicable **Lens runs** in parallel; each Lens run produces a **LensReport** of **Findings** or skips.
- **Severity** of a Finding determines the **Verdict**: any `blocker` ⇒ `changes-requested`; otherwise `commented` or `approved` per config.
- A **Verdict** produces both a **Verdict envelope** (bus) and, with `--post`, a **Review comment** (Forge) via a **PostAction**.
- A **Forge backend** is the only thing that talks to the **Forge**; the Review pipeline calls Forge backends through the interface, never directly.
- A **Substrate** is the only thing that talks to a **Provider**; Lenses call Substrates through the interface, never directly.
- **Prior Findings** flow from earlier Reviews on the same **PR** into every **Lens run** of the next Review.
- **ContextDrift** consumes target-repo architecture context docs, especially `CONTEXT.md`, to check whether new vocabulary or public surfaces drift from canonical bounded-context language.
- A **Task envelope** triggers a Review; the Review emits a **Verdict envelope**; cortex's `ReviewConsumer` emits the **Lifecycle envelopes** around them.

## Example dialogue

> **Dev:** A `code.pr.review.changes-requested` envelope landed for PR #58. What did Sage actually do?
> **Domain expert:** Sage performed a **Review** — fetched the PR via the GitHub **Forge backend**, ran every applicable **Lens** (CodeQuality always, then any whose Applicability matched the diff) through the configured **Substrate**, collected the **Findings**, and `decideVerdict()` returned `changes-requested`.
> **Dev:** Why `changes-requested`?
> **Expert:** At least one **Finding** carried **Severity** `blocker`. Severity is earned — `important` and below stay comment-only.
> **Dev:** Sage posted a comment on GitHub too?
> **Expert:** Right — that's the **Review comment**, the Forge-visible surface. The CLI was invoked with `--post` (or the Task envelope's `payload.post` was true), so the **PostAction** `request-changes` fired on the GitHub Forge backend.
> **Dev:** And if the post had failed?
> **Expert:** Then the **Verdict envelope** would still have emitted, plus a **Lifecycle envelope** with action `post-failed` carrying the error. The Verdict markdown is saved under `~/.config/sage/reviews/…` so nothing is lost.

## Flagged ambiguities

- **`review` was overloaded** — the act, the artifact on the bus, the comment posted, the forge enum, the CLI subcommand. Resolved into **Review** (act), **Verdict** (decision), **Verdict envelope** (bus artifact), **Review comment** (forge body), **PostAction** (forge enum). The CLI subcommand `sage review` is named after the act.
- **`ReviewEvent` was misleading.** It sounded like a bus event but is a forge-API enum mapping a Verdict to a Forge call. Resolved: **PostAction**.
- **`lens` did two jobs** — concern category and per-PR execution. Resolved into **Lens** (static category) and **Lens run** (per-PR execution).
- **`flavor` was sage-local jargon for what myelin already named.** The capability tail in `code-review.typescript` is a `{subcapability}` per myelin's namespace grammar. Resolved: **`{subcapability}`** is canonical; "flavor" is killed across the codebase.
- **"broadcast" Subject was a misread of cortex.** Sage README called the Offer Subject "broadcast"; cortex CONTEXT explicitly avoids that word because exactly one Assistant claims an offered task. Resolved: **Offer Dispatch** (cortex term) is canonical.
- **`{org}` in subject templates.** Sage README uses `{org}` in the Subject pattern; ecosystem-wide that segment is **`{principal}`**, and `metafactory` is the **network**, never a Subject segment. Resolved: README needs updating to `{principal}`.
- **`persona` is a sage concept, not a cortex one.** Cortex CONTEXT explicitly resolves `persona → assistant`. Within Sage's bounded context **Persona** is the voice/principles file (`persona.md`); the Assistant itself is *Sage*. The file `personas/sage.md` is "Sage's Persona file" — same shape cortex uses for filenames.
- **`substrate` vs `provider`.** Two layers, often conflated. Substrate = the harness subprocess Sage launches. Provider = the LLM vendor the harness talks to. Sage never speaks Provider; the Substrate does.
- **"Bus" is informal.** myelin owns the formal term **Transport**. Sage docs may use "bus" colloquially; in any formal context use **Transport**.

## Boundary with adjacent contexts

Reconciled in `compass/ecosystem/CONTEXT-MAP.md`. Sage consumes the published language of myelin and cortex.

| Term | Owner | Sage's relationship |
|---|---|---|
| **Envelope**, **Payload**, **Subject**, **Scope**, **Sovereignty**, **`signed_by`**, **`source`**, **Stamp**, **Identity**, **Principal**, **Hub**, **Network**, **Transport**, **DID**, **`@did-…` encoding** | myelin | Consumed. Sage publishes Envelopes on Subjects defined by myelin's namespace grammar. Sage never redefines any of these. |
| **Stack**, **Capability**, **Assistant**, **Agent**, **Sub-agent**, **Dispatch** (Offer/Direct/Delegate), **Domain** (segment), **dead-letter** | cortex | Consumed. Sage **is** an Assistant (`did:mf:sage`) hosted in-process by a cortex Agent. Sage declares Capabilities; cortex Offer-Dispatches Task envelopes to those Capabilities; cortex's `ReviewConsumer` claims them on Sage's behalf. |
| **`ReviewConsumer`**, **`pipelineRunner`** | cortex | Consumed. `ReviewConsumer` is cortex's subscriber that owns ack/nak, redelivery, signature verification (D1), and Lifecycle envelope emission. It invokes Sage's `reviewPr` as the injected `pipelineRunner`. The seam between cortex and Sage. |
| **Skill** | soma | Not used by Sage directly. Sage is a Capability (cortex term), not a skill (soma term). |

- `sage:Assistant` ≡ `cortex:Assistant` — Sage is one of the named beings cortex hosts.
- `sage:Persona` is sage-local — the file holding Sage's voice. Cortex's `Avoid: persona` rule refers to persona-as-domain-entity; persona-as-filename is fine ecosystem-wide.
- `sage:Provider` is sage-local and does not conflict — neither myelin nor cortex uses the word.
- `sage:Forge` is sage-local — neither myelin nor cortex has a competing definition.
