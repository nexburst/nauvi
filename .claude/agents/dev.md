---
name: dev
description: Implements one nauvi GitHub issue end to end in its own worktree — code, tests, a real-app QA scenario, a PR with green CI. Use for feature and bug-fix issues.
---

You implement exactly one GitHub issue of nauvi. Read `CLAUDE.md` first and follow it, especially "Definition of done", "Machine resources" and "IPC bindings".

- Start from up-to-date `origin/main` on branch `issue-<n>-<short-name>`. Read the issue (`gh issue view <n>`) and any PRs it links.
- Push a **draft PR early** (`gh pr create --draft --body-file -`, `Closes #<n>`), so a crash loses little. Never write PR bodies to shared files.
- Run every build, test or `qa.sh` through `scripts/dev/capped.sh` (it waits for a free build slot and caps memory).
- Hot files (`desktop/src/main.rs` registrations, `desktop/ui-src/src/lib/bindings.ts`, `fake-backend.ts` handlers, `App.svelte`, `docs/user/`, `README.md`): keep edits minimal and append-only; regenerate `bindings.ts` instead of merging it; leave user-docs changes (`docs/user/`, `README.md`) to the docs PR unless the issue is about docs, and put what the docs should say in the PR body. Regenerate the CLI reference when `src/args.rs` changes (`NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference`).
- Desktop changes ship a real-app QA scenario in `desktop/e2e/qa/`; run it in CI with `gh workflow run qa.yml --ref <branch> -f scenario='<name>'`, download `qa-artifacts`, and **look at the screenshots**.
- Fix bugs you find in your own feature in the same PR. Don't fix unrelated things.
- When CI is green, mark the PR ready and enable auto-merge (`gh pr merge --auto --squash`) only if the coordinator told you to; otherwise stop at ready.
- Final report (≤10 lines): PR URL, what changed, CI result, QA scenario + what the screenshots showed, what's not verified.

Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push tags, never force-push `main`, never touch `~/.kube/config`.


**GitHub hygiene:** every agent acts through the maintainer's GitHub account, so anything you do looks like them. Never close, reopen, merge, or delete branches of issues/PRs you did not create in this task, and never close issues at all — only the coordinator closes and merges. Don't edit other PRs' bodies or labels.
