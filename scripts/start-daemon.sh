#!/usr/bin/env bash
# Postinstall (LAST): launchctl load the sage daemon.
# Per spec §3.2 — daemon connects bus + self-registers capabilities.
#
# Idempotent: unloads any prior copy first to handle reinstall cleanly.
set -euo pipefail

PLIST="${HOME}/Library/LaunchAgents/ai.meta-factory.sage.plist"

if [[ ! -f "$PLIST" ]]; then
  # Plist absent = darwin-launchd host adapter didn't run (e.g., install on
  # Linux, or arc < 0.26.0 without launchd P3). Soft-skip so the install
  # transaction completes — operator can install manually if they want
  # daemon supervision later.
  echo "sage start-daemon: plist not found at $PLIST — skipping launchctl bootstrap (not an error)" >&2
  exit 0
fi

# Ensure log dir exists. Sage uses ~/.config/sage/logs/ rather than arc's
# default ~/Library/Logs/sage/ so all sage state (config + logs + cache)
# lives under a single ~/.config/sage/ root. launchctl errors on missing
# StandardOutPath / StandardErrorPath, so we mkdir before bootstrap.
LOG_DIR="${HOME}/.config/sage/logs"
mkdir -p "$LOG_DIR"

# Unload first if loaded (no-op if not loaded). bootout returns non-zero
# on "not loaded" — swallow that case.
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true

# Load (and start).
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "sage start-daemon: loaded $PLIST"
exit 0
