#!/usr/bin/env bash
# Preinstall: verify at least one supported LLM substrate is available.
set -euo pipefail

substrates=()
for bin in pi claude codex; do
  if command -v "$bin" >/dev/null 2>&1; then
    substrates+=("$bin")
  fi
done

if [ "${#substrates[@]}" -eq 0 ]; then
  echo "sage preinstall: no supported LLM substrate on PATH (need one of: pi, claude, codex)" >&2
  echo "  pi docs: https://pi.dev/docs/latest/usage" >&2
  echo "  claude docs: https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview" >&2
  echo "  codex: install the Codex CLI and run Sage with --substrate codex" >&2
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
