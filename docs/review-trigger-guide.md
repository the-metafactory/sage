# Canonical Review Trigger Guide

This is the agent-facing reference for asking Sage for a code review from a
Cortex environment.

## Short Answer

Use Pilot for bus-driven reviews:

```bash
PILOT_PRINCIPAL=jc pilot request-review \
  --pr the-metafactory/cortex#483 \
  --capability code-review.typescript \
  --wait \
  --timeout 30m
```

That is the canonical path for coding agents because it does the load-bearing
work:

- publishes a `tasks.code-review.<flavor>` Myelin envelope on the correct
  stack-aware subject
- signs the envelope when `~/.config/nats/pilot.creds` is available
- returns the published envelope id as `correlation_id`
- waits on both verdict families currently seen in the ecosystem:
  `code.pr.review.*` and `review.verdict.*`
- also waits for `dispatch.task.failed` so a rejected task fails fast instead
  of timing out silently

If the bus path is unhealthy and the agent only needs the review itself, bypass
Cortex and run Sage directly:

```bash
sage review the-metafactory/cortex#483 --post
```

`sage review` does not use NATS or Cortex. It needs only forge auth (`gh` or
`glab`) and one configured Sage substrate (`pi`, `claude`, or `codex`).

## Decision Table

| Path | Use When | Requires | Reliability Notes |
| --- | --- | --- | --- |
| `pilot request-review --wait` | A coding agent wants a Cortex bus review | running NATS, running Cortex review consumer, correct principal/stack, Pilot signing creds when Sage verifies trust | Canonical bus path. This is the one agents should automate. |
| `sage review ... --post` | The bus is broken or no Cortex round-trip is needed | forge auth and a local Sage substrate | Most deterministic review path. It bypasses lifecycle and dashboard bus events. |
| `sage dispatch ...` | An operator wants Sage's publisher CLI for a local unsigned or trust-disabled setup | running NATS and Cortex review consumer | Not canonical for signed Cortex installs because this publisher does not sign review-request envelopes. |
| Raw NATS publish | You are implementing a publisher, not operating a coding session | exact subject, exact envelope shape, valid signature chain, matching principal/stack | Easy to get subtly wrong. Prefer Pilot unless you are changing transport code. |

## Correct Bus Contract

### Request Subject

Publish review tasks to:

```text
local.<principal>.<stack>.tasks.code-review.<flavor>
```

Example:

```text
local.jc.default.tasks.code-review.typescript
```

`<flavor>` should normally be one of:

```text
typescript, python, rust, go, sql, docs, security, generic
```

These map to Sage's installed `runtime.capabilities` values:

```text
code-review.typescript
code-review.python
code-review.rust
code-review.go
code-review.sql
code-review.docs
code-review.security
code-review.generic
```

### Request Envelope

The envelope `type` must match the task capability:

```json
{
  "type": "tasks.code-review.typescript",
  "source": "jc.default.pilot",
  "sovereignty": {
    "classification": "local",
    "data_residency": "CH",
    "max_hop": 0,
    "frontier_ok": true,
    "model_class": "any"
  },
  "payload": {
    "pr_url": "https://github.com/the-metafactory/cortex/pull/483",
    "owner": "the-metafactory",
    "repo": "cortex",
    "number": 483,
    "pr": 483,
    "reviewer": "capability-dispatch"
  }
}
```

Notes:

- `source` is `{principal}.{stack}.pilot` for Pilot-originated requests.
- The receiving Cortex consumer accepts either `pr_url`, or
  `owner` + `repo` + `number`, or legacy `repo: "owner/name"` + `pr`.
- `reviewer` is informational for Offer dispatch. Capability and subject route
  the task.
- If asking Cortex/Sage to post the review to GitHub, include `"post": true`.
  Omit the field otherwise. Do not send `"post": false`.
- For GitLab, include `"forge": "gitlab"` and use a GitLab MR `pr_url`.

### Signature Requirement

In current Sage installs, `sage.md` declares a non-empty `trust:` list. Cortex
therefore wires signature verification for Sage's review consumer. Unsigned or
untrusted envelopes are rejected with `dispatch.task.failed` containing a
`chain verification failed` detail, commonly `empty_chain`.

Pilot is the safe publisher because it signs with `~/.config/nats/pilot.creds`
when that file exists. A hand-rolled publisher must use the same Myelin envelope
builder and sign the envelope with a trusted identity before publishing.

Do not use `nats pub ... '{...json...}'` as an agent workflow unless the target
review consumer is explicitly running with trust verification disabled.

### Response Subjects

A robust waiter must listen by the original request envelope id:

```text
correlation_id == <request envelope id>
```

Subscribe to both verdict families:

```text
local.<principal>.<stack>.code.pr.review.>
local.<principal>.<stack>.review.verdict.>
```

Also subscribe to failure lifecycle:

```text
local.<principal>.<stack>.dispatch.task.failed
```

Cortex also emits lifecycle progress/completion:

```text
local.<principal>.<stack>.dispatch.task.started
local.<principal>.<stack>.dispatch.task.completed
```

The review verdict is the primary review result. `dispatch.task.completed` is a
lifecycle close signal and may not contain a structured review verdict.

## Required Preflight

Before blaming Sage, verify the receiving Cortex stack:

```bash
nats stream info CODE_REVIEW
nats consumer info CODE_REVIEW cortex-review-consumer-jc-sage
```

Expected:

- the stream covers `local.jc.default.tasks.code-review.>` or a deliberate
  broader pattern such as `local.>`
- the durable exists for the Sage agent
- Cortex logs contain `cortex: review consumer ready for agent=sage`
- the log line says `signed=on` when Sage trust verification is active

If `sage dispatch` or Pilot prints a no-consumer/silence warning after a few
seconds, check:

- `principal` matches the receiving Cortex `agent.operatorId` /
  `agent.principalId`
- `stack` matches the receiving Cortex stack id segment
- Cortex is not logging `review consumer DORMANT`
- JetStream stream and durable were provisioned
- the request envelope is signed by a trusted publisher when `signed=on`

## Failure Meanings

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `empty_chain` or `chain verification failed` | request was unsigned or signer is not trusted | use `pilot request-review`, provision `pilot.creds`, or add the correct trust relationship |
| no lifecycle envelope after publish | subject mismatch or dormant review consumer | verify principal, stack, stream, durable, and Cortex boot logs |
| `dispatch.task.failed` with `cant_do` payload validation | malformed task payload | include `pr_url` or `owner` + `repo` + `number`; keep `repo` slash-free in the canonical triple |
| timeout after `dispatch.task.started` | review pipeline did not emit a terminal envelope | inspect Cortex/Sage logs and the substrate subprocess |
| review posted to GitHub but waiter timed out | waiter listened to only one verdict family | listen to both `code.pr.review.*` and `review.verdict.*`, or use Pilot |

## Practical Rules For Agents

1. Prefer `pilot request-review --wait --timeout 30m`.
2. Set `PILOT_PRINCIPAL` when the environment cannot reliably read the same
   `cortex.yaml` as the receiving Cortex process.
3. Use `--capability code-review.generic` when the language is unclear.
4. Use `sage review ... --post` as the deterministic fallback when the bus is
   unhealthy.
5. Do not use `sage dispatch` as the default in signed Cortex environments.
6. Do not hand-publish JSON to NATS unless you also sign it and wait on both
   verdict families plus `dispatch.task.failed`.
