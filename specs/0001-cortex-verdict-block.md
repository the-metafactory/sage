# Spec 0001 — Cortex verdict-block emission

**Issue:** the-metafactory/sage#83
**Status:** IMPLEMENT (Tier 1)

## Problem

`sage review` emits only the human-readable `renderVerdict` markdown. cortex's
review path over the bus (the `pi-dev` substrate runner, cortex#331) shells
`sage review <pr> --substrate <s>`, captures stdout, and derives the verdict
**from the process exit code only** — exit 0 → `commented`, exit 1 →
`changes-requested`. It explicitly does no structured parsing (Phase 1 scope).

Consequences:
- `approved` is unreachable — a clean PR exits 0 and is reported `commented`.
- Findings counts (blockers/majors/nits) are lost.
- pilot's merge gate never sees `approved`, so the autonomous loop cannot
  proceed to merge.

cortex's Phase-2 plan (pi-dev-runner.ts:41) is to parse a structured verdict
block from sage's stdout. This spec is the sage side of that contract.

## Contract (cortex review-pipeline.ts `parseVerdictBlock`, frozen)

The LAST fenced ` ```json ` block in stdout MUST be a JSON object:

```json
{
  "verdict": "approved" | "changes-requested" | "commented",
  "summary": "<string>",
  "github_review_id": <integer>,
  "github_review_url": "<string>",
  "submitted_at": "<ISO 8601 string>",
  "commit_id": "<string — head SHA>",
  "findings": { "blockers": <int>, "majors": <int>, "nits": <int> },
  "inline_comments": <integer>
}
```

All fields required; integers must be integers (0 valid); strings must be
strings ("" valid).

## Requirements

### Requirement: Verdict-block serialization
The system SHALL provide a pure `renderVerdictBlock(verdict, meta)` emitting a
fenced ` ```json ` block matching the contract. `verdict` equals
`verdict.decision` verbatim (enum already aligned).

### Requirement: Severity → findings mapping
Sage severities map to cortex buckets: `blocker`→`blockers`,
`important`→`majors`, `suggestion`+`nit`→`nits`.

### Requirement: Commit id
`commit_id` SHALL be the PR head commit SHA, sourced from
`PrMetadata.headRefOid` (added to the shared schema; github + gitlab backends
populate it).

### Requirement: CLI opt-in
`sage review` SHALL accept `--emit-verdict-block`. When set, the fenced block is
appended as the terminal stdout artefact, after the human body. Default off —
existing offline output is unchanged.

### Requirement: Round-trip
A block from `renderVerdictBlock` SHALL satisfy cortex's `parseVerdictBlock`
(contract test mirrors cortex's field checks).

## Out of scope (Tier 2 — follow-up)

- **Real `github_review_id` / `github_review_url`.** Tier 1 emits link-less
  defaults (`0` / `""`) — contract-valid; cortex recovers the verdict + findings
  (the load-bearing fields) without them. Capturing the posted review's id/url
  requires extending `ForgeBackend.postReview` + a `gh api` follow-up read, and
  is tracked separately so this slice stays reviewable.
- Inline review comments (`inline_comments` is always 0 — sage posts a single
  summary review).
- cortex's pi-dev-runner parsing the block + passing `--emit-verdict-block`
  (tracked in cortex#888).
