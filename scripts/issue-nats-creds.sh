#!/usr/bin/env bash
# Postinstall (SECOND): mint per-agent NATS credentials for sage.
# Per spec §6.3 + D8 — cortex shells out to `arc nats add-bot sage --json`
# (arc-delegated signing model, cortex#79; arc owns nsc and the operator $SYS
# account). The fragment MUST already be visible to the cortex registry
# before this runs so the credential can be scoped to sage's declared
# `runtime.capabilities`.
set -euo pipefail

cortex creds issue sage
