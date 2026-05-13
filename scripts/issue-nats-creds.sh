#!/usr/bin/env bash
# Postinstall (SECOND): mint per-agent NATS credentials for sage.
# Per spec §6.3 + D8 — cortex shells out to `arc nats add-bot sage --json`
# (arc-delegated signing model, cortex#79; arc owns nsc and the operator $SYS
# account). The fragment MUST already be visible to the cortex registry
# before this runs so the credential can be scoped to sage's declared
# `runtime.capabilities`.
#
# Idempotency: arc 0.26.0 treats non-zero exit from postinstall as an
# install abort + rollback. Missing cortex / cortex without `creds issue`
# subcommand is a legitimate dev-mode state (local unauthenticated NATS
# doesn't need creds). Warn and exit 0 so install completes; operator
# can run `cortex creds issue sage` manually when the secured broker
# topology is in place.
set -euo pipefail

if ! command -v cortex >/dev/null 2>&1; then
  echo "sage issue-nats-creds: 'cortex' CLI not on PATH — skipping (dev mode)" >&2
  exit 0
fi

if ! cortex creds issue sage 2>/dev/null; then
  echo "sage issue-nats-creds: 'cortex creds issue' failed or not supported in this cortex version — skipping" >&2
  echo "  to mint creds later: cortex creds issue sage" >&2
  exit 0
fi
