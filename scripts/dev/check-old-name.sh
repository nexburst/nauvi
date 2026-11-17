#!/usr/bin/env bash
# Fails if the project's old name is still in a tracked file or path (#337).
# The one allowed mention is the history note in docs/decisions.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

old="kube""loupe" # split so this script doesn't match itself
allow=(docs/decisions/0008-rename-to-nauvi.md)

excludes=()
for f in "${allow[@]}"; do excludes+=(":(exclude)$f"); done

status=0
if git grep -n -I -i "$old" -- . "${excludes[@]}"; then
  echo "error: the old name is still in the files above; use nauvi" >&2
  status=1
fi
if git ls-files | grep -i "$old"; then
  echo "error: the old name is still in the paths above" >&2
  status=1
fi
exit "$status"
