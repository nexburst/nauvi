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
#   HEAVY_SLOTS=1 scripts/dev/capped.sh cargo build -p nauvi-desktop
#
# The memory ceiling uses a transient systemd user scope (no sudo); without
# systemd the command runs without one. Without flock, there are no slots.
#
# macOS: works with the system bash 3.2 (hence the fixed descriptor 9 below,
# not `exec {fd}>`, which needs bash 4.1). flock isn't built in: install it
# with `brew install flock` to get slots. There is no systemd, so no memory
# ceiling; use HEAVY_SLOTS=1 on a small Mac.
set -euo pipefail
cap="${CAP:-6G}"
slots="${HEAVY_SLOTS:-2}"
lockdir="${XDG_RUNTIME_DIR:-/tmp}/nauvi-heavy"
mkdir -p "$lockdir"

if [ -z "${NAUVI_SLOT_HELD:-}" ]; then
  if command -v flock >/dev/null 2>&1; then
    # Take the first free slot; if all are busy, wait for slot 1. The slot is
    # held through descriptor 9 until this script (and the command) ends.
    for i in $(seq 1 "$slots"); do
      exec 9>"$lockdir/slot-$i.lock"
      if flock -n 9; then got=$i; break; fi
      exec 9>&-
    done
    if [ -z "${got:-}" ]; then
      echo "capped.sh: all $slots heavy slots are busy; waiting…" >&2
      exec 9>"$lockdir/slot-1.lock"
      flock 9
    fi
    # Nested capped.sh calls (e.g. qa.sh building the app) reuse this slot.
    export NAUVI_SLOT_HELD=1
  else
    echo "capped.sh: flock not found, running without a build slot (macOS: brew install flock)" >&2
  fi
fi

if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  # Not exec: keep this shell (and the slot lock it holds) until the command ends.
  systemd-run --user --scope --quiet -p MemoryMax="$cap" -p MemorySwapMax=1G -- "$@"
  exit $?
fi
"$@"
