#!/usr/bin/env bash
# Fails if the project's old name is still in a tracked file or path (#337).
# Allowed: the history note in docs/decisions, and the one "formerly" line
# of the README (matched as a whole line, so the rest of the README is checked).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

old="kube""loupe" # split so this script doesn't match itself
allow=(docs/decisions/0008-rename-to-nauvi.md)
allow_lines=(
  "README.md:Formerly ${old} ([why it was renamed](docs/decisions/0008-rename-to-nauvi.md))."
)

excludes=()
for f in "${allow[@]}"; do excludes+=(":(exclude)$f"); done

status=0
hits=$(git grep -I -i "$old" -- . "${excludes[@]}" || true)
for line in "${allow_lines[@]}"; do
  hits=$(grep -v -x -F -- "$line" <<<"$hits" || true)
done
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
