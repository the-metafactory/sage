#!/usr/bin/env bash
# Preuninstall (FIRST): launchctl unload the sage daemon.
# Per spec §8.3 — daemon stops claiming new tasks; drain-tasks.sh
# follows with a bounded wait for in-flight reviews.
set -euo pipefail

PLIST="${HOME}/Library/LaunchAgents/ai.meta-factory.sage.plist"

# If the plist isn't there, the daemon was never installed via launchd —
# nothing to do.
if [[ ! -f "$PLIST" ]]; then
  exit 0
fi

# bootout is the modern equivalent of `launchctl unload` and is
# idempotent when paired with the `|| true` for "not loaded" exits.
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true

echo "sage stop-daemon: unloaded $PLIST"
exit 0
