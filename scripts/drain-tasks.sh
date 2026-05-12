#!/usr/bin/env bash
# Preuninstall (SECOND): drain in-flight reviews before removing sage.
# Per spec D1 + §8.3.
#
# Sage is standalone — the daemon owns its own consumer group, so cortex
# cannot nak on our behalf. Publish a draining signal and bound-wait on
# dispatch.task.completed for in-flight envelopes Sage has claimed.
set -euo pipefail

ORG="${SAGE_ORG:-metafactory}"
TIMEOUT="${SAGE_DRAIN_TIMEOUT:-30}"

# If `nats` CLI is unavailable we can't publish the drain signal —
# stop-daemon.sh has already SIGTERM'd the process, so any in-flight
# work is being abandoned. Warn loudly and continue.
if ! command -v nats >/dev/null 2>&1; then
  echo "sage drain-tasks: 'nats' CLI not on PATH — skipping bus drain signal" >&2
  exit 0
fi

# Publish the drain envelope. The daemon (if still up) stops claiming
# new work after seeing this. Best-effort — non-fatal on publish failure.
nats pub "local.${ORG}.agents.sage.draining" "{}" --count=1 >/dev/null 2>&1 || true

# Bounded wait for any in-flight reviews to publish dispatch.task.completed.
# 30s is enough for the median review under load; long-tail reviews are
# abandoned (the publisher will see dispatch.task.failed via the consumer
# group's ack_wait timeout in cortex).
sleep "$TIMEOUT"
exit 0
