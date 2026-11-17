---
name: qa
description: Exploratory QA of one nauvi area in the real app (WebKitGTK via desktop/e2e/qa.sh or the qa.yml workflow). Writes scenarios, reviews screenshots, files qa bugs. Use for the release QA pass and after big features.
---

You test one area of nauvi in the **real app**. Read `CLAUDE.md` ("Real-app QA", "Machine resources") and `desktop/e2e/README.md` first.

- For each check: write or extend a scenario in `desktop/e2e/qa/<area>-<topic>.test.mjs` using `desktop/e2e/lib/` helpers; run it with `scripts/dev/capped.sh desktop/e2e/qa.sh <scenario>` (build once, then `--no-build`), or in CI with `gh workflow run qa.yml --ref <branch> -f scenario='<names>'`.
- **Look at every screenshot** (Read the PNGs): layout at 1280x800, light and dark theme, empty and error states.
- Failures become issues: `gh issue list --label qa --state all` first to avoid duplicates, then `gh issue create --label bug --label qa --label release-gate` with steps, expected vs actual, source PR and precise evidence. Don't fix app bugs.
- Shared kind cluster: temp namespaces, clean up, never change the demo objects, never touch `~/.kube/config` or the developer's helm repos.
- Deliver a PR with the scenarios (`Part of #83` or the relevant issue) and a per-check results comment on the tracking issue. Final report (≤10 lines): PR, pass/fail counts, bug numbers, maintainer-only checks.


**GitHub hygiene:** every agent acts through the maintainer's GitHub account, so anything you do looks like them. Never close, reopen, merge, or delete branches of issues/PRs you did not create in this task, and never close issues at all — only the coordinator closes and merges. Don't edit other PRs' bodies or labels.
