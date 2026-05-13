#!/usr/bin/env bash
# Postinstall (FIRST) / Preuninstall (LAST): tell cortex to re-read
# ~/.config/cortex/agents.d/ so the daemon picks up sage's fragment
# BEFORE creds issuance scopes the credential to sage's capabilities.
# Per spec §6.1 + §8.1.
#
# Idempotency contract: arc 0.26.0 (arc#140 P5) treats any non-zero exit
# from lifecycle scripts as an abort signal. "Cortex daemon isn't
# running" is a legitimate state (the operator may not have started it
# yet, or may have already shut it down) and MUST NOT block install or
# uninstall — matches the arc#138 philosophy that "operators need cleanup
# to finish even when a daemon was already dead". So all paths below
# soft-fail to exit 0.
set -euo pipefail

# Tier 1 — `cortex agents reload` subcommand (cortex Phase A.4 future hook).
# Not in cortex 0.1.0 yet but cheap to try; first `command -v` guard
# avoids stalling when the cortex CLI is absent.
if command -v cortex >/dev/null 2>&1 && cortex agents reload >/dev/null 2>&1; then
  exit 0
fi

# Tier 2 — launchctl kickstart of the cortex bot launchd service.
# Cleanest path because launchd handles the supervision contract;
# kickstart -k forces a stop-and-restart so the daemon re-reads
# agents.d/ on startup. No orphan-process or signal-handling risk.
LABEL="ai.meta-factory.cortex.bot"
if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 && exit 0
fi

# Tier 3 — SIGHUP whatever cortex bot process is alive. Pattern matches:
#   `bun ~/bin/cortex start ...`     (manual / installed launcher)
#   `cortex start ...`                (any direct invocation)
#   process backed by the launchd label above
# The old pattern `cortex.*bot` silently no-op'd because the daemon's
# actual command is `cortex start`, not `cortex bot` (relic from an
# earlier cortex CLI shape).
pid=$(pgrep -f 'cortex start\|ai\.meta-factory\.cortex' | head -n1 || true)
if [[ -n "$pid" ]]; then
  kill -HUP "$pid" 2>/dev/null && exit 0
fi

echo "sage signal-cortex-reload: cortex daemon not reachable via any tier — skipping reload (not an error)" >&2
exit 0
