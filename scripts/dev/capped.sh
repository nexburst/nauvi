#!/usr/bin/env bash
# Run a heavy command (cargo build/test, qa.sh, npm builds) so it can't take
# the whole machine down:
#   - it waits for one of HEAVY_SLOTS build slots (default 2), shared by every
#     agent and shell on this machine, so at most that many run at once;
#   - it runs under a memory ceiling (CAP, default 6G), so a runaway one is
#     killed alone instead of the OOM killer taking every agent with it.
#
#   scripts/dev/capped.sh cargo test --workspace
#   CAP=4G scripts/dev/capped.sh desktop/e2e/qa.sh terminal
#   HEAVY_SLOTS=1 scripts/dev/capped.sh cargo build -p kubeloupe-desktop
#
# The memory ceiling uses a transient systemd user scope (no sudo); without
# systemd the command runs without one. Without flock, there are no slots.
set -euo pipefail
cap="${CAP:-6G}"
slots="${HEAVY_SLOTS:-2}"
lockdir="${XDG_RUNTIME_DIR:-/tmp}/kubeloupe-heavy"
mkdir -p "$lockdir"

if command -v flock >/dev/null 2>&1 && [ -z "${KUBELOUPE_SLOT_HELD:-}" ]; then
  # Take the first free slot; if all are busy, wait for slot 1.
  for i in $(seq 1 "$slots"); do
    exec {fd}>"$lockdir/slot-$i.lock"
    if flock -n "$fd"; then got=$i; break; fi
    exec {fd}>&-
  done
  if [ -z "${got:-}" ]; then
    echo "capped.sh: all $slots heavy slots are busy; waiting…" >&2
    exec {fd}>"$lockdir/slot-1.lock"
    flock "$fd"
  fi
  # Nested capped.sh calls (e.g. qa.sh building the app) reuse this slot.
  export KUBELOUPE_SLOT_HELD=1
fi

if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  # Not exec: keep this shell (and the slot lock it holds) until the command ends.
  systemd-run --user --scope --quiet -p MemoryMax="$cap" -p MemorySwapMax=1G -- "$@"
  exit $?
fi
"$@"
