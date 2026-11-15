# 0004: Agent workflow

**Status:** accepted (2026-11-15). Details: #110, #117, #125, `CLAUDE.md`.

## Context
Most work is done by Claude Code agents. Lessons from the first large run:
five build-heavy agents at once got the whole session killed by the OOM killer;
leftover worktrees filled the disk; parallel PRs collided on a few hot files and
needed repeated updates; QA after merge found many bugs; agents sharing a
scratch file pushed wrong PR bodies; an agent closed an unmerged PR through the
maintainer's account; GitHub's cache limit was exceeded.

## Decision
- **One coordinator session plus short-lived role subagents** (`dev`, `qa`,
  `reviewer`, see `.claude/agents/`), each in its own git worktree. No
  long-lived role sessions.
- **No cloud workers**: the coordinating session must be able to see, steer and
  stop every worker. Extra build capacity comes from other machines driven over
  SSH by a local subagent, under the same permission checks.
- **Merge gate**: required CI checks (branch protection; branches need not be
  up to date), a reviewer verdict, and for desktop changes a real-app QA
  scenario with screenshots looked at; then auto-merge.
- **Only the coordinator closes, reopens or merges** issues and PRs.
- **Resource limits**: at most two build-heavy jobs per small machine
  (`scripts/dev/capped.sh` build slots + memory ceilings); merged worktrees are
  removed automatically; Rust caches are saved only from `main`.
- Hot files are append-only lists; generated files are regenerated, not merged.

## Consequences
Slower peak throughput on a small machine, but fewer crashes, less churn, and
every change reviewed and observed by one place.
