#!/usr/bin/env bash
# Preuninstall: tear down the pre-sage#40 standalone launchd daemon and
# remove its plist file from ~/Library/LaunchAgents/.
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
# Detach-first ordering (cycle-3 finding #1):
#   The previous shape guarded everything behind `if [[ -f "$LEGACY_PLIST" ]]`,
#   which silently skipped the detach when an operator had hand-removed the
#   plist file but left the launchd job loaded. Loaded-without-plist is a
#   real state (half-finished upgrade, manual `rm` without `bootout`), and
#   in that state the legacy daemon survived this hook entirely. Flip the
#   order: attempt the detach unconditionally, THEN delete the plist file
#   if it's still on disk. Each step is independently idempotent.
#
# Idempotent:
#   - Both `launchctl bootout` and `launchctl remove` are wrapped in
#     `|| true` so a missing or already-bootouted job is a clean exit.
#   - `rm -f` on the plist is a no-op when the file is absent.
#
# Run FIRST in `preuninstall` so the legacy daemon stops claiming work
# before `signal-cortex-reload.sh` tears down the in-process consumer
# and `drain-tasks.sh` waits on in-flight completion envelopes.
set -euo pipefail

LEGACY_LABEL="ai.meta-factory.sage"
LEGACY_PLIST="${HOME}/Library/LaunchAgents/${LEGACY_LABEL}.plist"

# Detach unconditionally. `bootout` is the modern verb (launchd ≥ 10.10);
# the `gui/<uid>/<label>` form references the loaded job by its label, so
# it works even when the plist file has been hand-deleted from disk —
# which is precisely the case the old `if [[ -f ]]` guard missed.
launchctl bootout "gui/$(id -u)/${LEGACY_LABEL}" 2>/dev/null || true
# Belt-and-suspenders for pre-bootstrap launchd vocabularies that don't
# accept `bootout` on user jobs. `launchctl remove` is the legacy verb
# for the same operation; non-zero exit just means "not loaded under
# that name", which is the desired post-condition.
launchctl remove "${LEGACY_LABEL}" 2>/dev/null || true

# Now retire the plist file if it's still on disk. Absence is fine — the
# detach above already covered the load state, and a missing plist on a
# fresh install is the common path. Stay quiet on the no-op so the
# install log isn't noisy.
if [[ -f "$LEGACY_PLIST" ]]; then
  rm -f "$LEGACY_PLIST"
  echo "sage cleanup-legacy-daemon: detached ${LEGACY_LABEL} and removed plist at $LEGACY_PLIST"
fi

exit 0
