#!/usr/bin/env bash
# Fails if the project's old name is still in a tracked file or path (#337).
# No exceptions (docs/decisions/0008).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

old="kube""loupe" # split so this script doesn't match itself

status=0
hits=$(git grep -I -i "$old" -- . || true)
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "error: the old name is still in the files above; use nauvi" >&2
  status=1
fi
if git ls-files | grep -i "$old"; then
  echo "error: the old name is still in the paths above" >&2
  status=1
fi
exit "$status"
