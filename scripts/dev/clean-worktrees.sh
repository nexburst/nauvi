#!/usr/bin/env bash
# Remove agent worktrees (.claude/worktrees/*) whose branch is merged.
# Each one holds its own target/ (several GB). A worktree is removed only if
#   - it has no uncommitted changes, and
#   - its HEAD is the head of a merged PR, or is already contained in origin/main.
# Locked worktrees (an agent still running) are skipped unless --unlock is given.
#
#   scripts/dev/clean-worktrees.sh          # dry run
#   scripts/dev/clean-worktrees.sh --yes    # remove
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
yes=0; unlock=0
for a in "$@"; do
  case "$a" in --yes) yes=1 ;; --unlock) unlock=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac
done
git fetch -q origin
merged=$(gh api "repos/{owner}/{repo}/pulls?state=closed&per_page=100" \
  --jq '.[] | select(.merged_at) | .head.sha' 2>/dev/null || true)
shopt -s nullglob
for w in .claude/worktrees/*/; do
  w=${w%/}
  branch=$(git -C "$w" branch --show-current 2>/dev/null || echo "?")
  if [ -n "$(git -C "$w" status --short 2>/dev/null)" ]; then
    echo "keep   $w ($branch): uncommitted changes"; continue
  fi
  head=$(git -C "$w" rev-parse HEAD)
  if ! grep -qx "$head" <<<"$merged" && ! git merge-base --is-ancestor "$head" origin/main 2>/dev/null; then
    echo "keep   $w ($branch): not merged"; continue
  fi
  if git worktree list --porcelain | grep -A3 "^worktree $PWD/$w\$" | grep -q '^locked'; then
    if [ "$unlock" = 0 ]; then echo "keep   $w ($branch): locked (agent running?), use --unlock"; continue; fi
    [ "$yes" = 1 ] && git worktree unlock "$w"
  fi
  size=$(du -sh "$w" 2>/dev/null | cut -f1)
  if [ "$yes" = 1 ]; then git worktree remove "$w" && echo "remove $w ($branch, $size)"
  else echo "would remove $w ($branch, $size)"; fi
done
git worktree prune
df -h / | tail -1
