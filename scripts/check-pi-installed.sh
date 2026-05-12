#!/usr/bin/env bash
# Preinstall: verify the pi.dev binary is available.
# Sage's entire reason for existing is to run reviews through pi —
# refuse to install without it.
set -euo pipefail

if ! command -v pi >/dev/null 2>&1; then
  echo "sage preinstall: 'pi' (pi.dev coding agent) not on PATH" >&2
  echo "  install with: npm i -g @earendil-works/pi-coding-agent" >&2
  echo "  docs: https://pi.dev/docs/latest/usage" >&2
  exit 1
fi

# Soft check: bun must be present so the daemon can run.
if ! command -v bun >/dev/null 2>&1; then
  echo "sage preinstall: 'bun' not on PATH — install from https://bun.sh" >&2
  exit 1
fi

# Soft check: gh must be authenticated so PR fetch/post works without
# additional prompting.
if ! gh auth status >/dev/null 2>&1; then
  echo "sage preinstall: 'gh' is not authenticated — run 'gh auth login'" >&2
  exit 1
fi

exit 0
