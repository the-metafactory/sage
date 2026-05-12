#!/usr/bin/env bash
# Postinstall (LAST): launchctl load the sage daemon.
# Per spec §3.2 — daemon connects bus + self-registers capabilities.
#
# Idempotent: unloads any prior copy first to handle reinstall cleanly.
set -euo pipefail

PLIST="${HOME}/Library/LaunchAgents/ai.meta-factory.sage.plist"

if [[ ! -f "$PLIST" ]]; then
  echo "sage start-daemon: plist not found at $PLIST" >&2
  exit 1
fi

# Unload first if loaded (no-op if not loaded). bootout returns non-zero
# on "not loaded" — swallow that case.
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true

# Load (and start).
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "sage start-daemon: loaded $PLIST"
exit 0
