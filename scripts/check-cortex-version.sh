#!/usr/bin/env bash
# Preinstall: verify cortex is installed + reachable.
# Per docs/design-arc-agent-bots.md §6.2 — CortexHostAdapter.detect().
#
# Today this is a CLI-presence check. Once cortex pins a stable
# agents.d/ contract version (Phase A.1), pin a `>=` range here.
set -euo pipefail

if ! command -v cortex >/dev/null 2>&1; then
  echo "sage preinstall: 'cortex' CLI not on PATH — install cortex first" >&2
  exit 1
fi

# TODO(cortex Phase A.1): when cortex publishes a stable agents.d/ schema
# version, query `cortex --version` and assert a compatible range.
exit 0
