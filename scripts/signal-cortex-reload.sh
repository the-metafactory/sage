#!/usr/bin/env bash
# Postinstall (FIRST) / Preuninstall (LAST): tell cortex to re-read
# ~/.config/cortex/agents.d/ so the daemon picks up sage's fragment
# BEFORE creds issuance scopes the credential to sage's capabilities.
# Per spec §6.1 + §8.1.
set -euo pipefail

# Preferred path: `cortex agents reload` (cortex Phase A.4).
if command -v cortex >/dev/null 2>&1 && cortex agents reload >/dev/null 2>&1; then
  exit 0
fi

# Fallback: SIGHUP the cortex daemon. The config watcher
# (src/common/config/watcher.ts, extended per spec §6.1) re-emits the
# same reload event as `cortex agents reload`.
pid=$(pgrep -f 'cortex.*bot' | head -n1 || true)
if [[ -n "$pid" ]]; then
  kill -HUP "$pid"
  exit 0
fi

echo "sage signal-cortex-reload: cortex daemon not running and 'cortex agents reload' unavailable" >&2
exit 1
