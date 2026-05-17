#!/usr/bin/env bash
# Preuninstall: tear down the pre-sage#40 standalone launchd daemon if it's
# still loaded, then remove the plist file from ~/Library/LaunchAgents/.
#
# Context (sage#40 cycle-1 finding #1):
#   Sage moved from a standalone launchd daemon to an in-process cortex
#   agent. Operators upgrading from the old shape still have
#   ~/Library/LaunchAgents/ai.meta-factory.sage.plist loaded. Without this
#   cleanup step, BOTH the legacy daemon and the new cortex-hosted
#   in-process consumer end up subscribed to the same broadcast pull
#   (`local.{org}.{stack}.tasks.code-review.>`) and split the work
#   non-deterministically.
#
#   Security framing: the legacy receiver predates cortex's D1 signature
#   verifier wiring (cortex#329/#330). A surviving legacy daemon would
#   accept unsigned envelopes on a path the new in-process consumer
#   rejects. Removing it on upgrade closes the bypass.
#
# Idempotent:
#   - `launchctl bootout` is wrapped in `|| true` so "service not loaded"
#     (after a fresh install, or a second upgrade pass) is a clean exit.
#   - `rm -f` on the plist is a no-op when the file is absent.
#
# Run FIRST in `preuninstall` so the legacy daemon stops claiming work
# before `drain-tasks.sh` waits on in-flight completion envelopes.
set -euo pipefail

LEGACY_PLIST="${HOME}/Library/LaunchAgents/ai.meta-factory.sage.plist"

if [[ -f "$LEGACY_PLIST" ]]; then
  # bootout is the modern equivalent of `launchctl unload`. Swallow the
  # non-zero exit for the "not loaded" case (legitimate when the operator
  # has already bootout'd manually, or when this script runs a second time).
  launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
  rm -f "$LEGACY_PLIST"
  echo "sage cleanup-legacy-daemon: removed legacy plist at $LEGACY_PLIST"
else
  # Fresh install path — nothing to clean up. Stay quiet so the install
  # log isn't noisy about a no-op.
  exit 0
fi

exit 0
