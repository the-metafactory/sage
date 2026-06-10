# Spec 0002 — `dispatch --org` defaults to the resolved principal

**Issue:** the-metafactory/sage#85
**Status:** IMPLEMENT

## Problem

`sage dispatch` defaults `--org` to the hardcoded `"metafactory"`
(`cli/index.ts`), but the cortex review consumer subscribes on the operator's
principal segment (e.g. `jc`). The mismatch publishes to
`local.metafactory.default.tasks.code-review.*` while the consumer listens on
`local.jc.default.…` → no claim → silent 5s timeout. A stock single-stack
operator has to know to pass `--org jc`.

## Requirements

### Requirement: principal resolution from cortex.yaml
The system SHALL resolve the operator principal from cortex config — read
`principal.id` from `$CORTEX_CONFIG` (default `~/.config/cortex/cortex.yaml`),
the same source pilot / cortex use.

- **GIVEN** a cortex.yaml with `principal.id: jc`
- **WHEN** the principal is resolved
- **THEN** it returns `"jc"`
- **AND** a missing file, unreadable file, or absent `principal.id` returns
  `undefined` (never throws)

### Requirement: `--org` default precedence
The `dispatch --org` default SHALL be, in order:
`SAGE_ORG` env → resolved cortex.yaml principal → `"metafactory"` (last-resort
back-compat). An explicit `--org` flag still overrides all of these.

## Out of scope

- Stack resolution (`SAGE_STACK` already exists; this spec is org/principal only).
- The split-layout config (`~/.config/cortex/<stack>/…`) — pilot reads the
  monolithic `cortex.yaml`; sage mirrors that path for parity.
