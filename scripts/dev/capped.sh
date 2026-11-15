#!/usr/bin/env bash
# Run a command under a memory ceiling so one runaway build or app run gets
# killed on its own instead of the OOM killer taking down every agent.
#
#   scripts/dev/capped.sh cargo test --workspace
#   CAP=3G scripts/dev/capped.sh desktop/e2e/qa.sh terminal
#
# Uses a transient systemd user scope (no sudo). Without systemd, it runs the
# command unchanged.
set -euo pipefail
cap="${CAP:-6G}"
if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  exec systemd-run --user --scope --quiet -p MemoryMax="$cap" -p MemorySwapMax=1G -- "$@"
fi
exec "$@"
