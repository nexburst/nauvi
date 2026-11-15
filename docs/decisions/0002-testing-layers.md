# 0002: Testing layers

**Status:** accepted (2026-11-14). Details: #7, #27, #28, #82, #83.

## Context
Agents write most of the code and cannot click through the GUI. Early PRs
ended with unchecked manual checklists, and the first real-app QA pass found
15+ bugs in features that had passed CI.

## Decision
Four layers, each in CI:

1. **Unit tests** (`cargo test --workspace`, Vitest for pure UI logic).
2. **UI tests against a fake backend**: Playwright in Chromium drives the real
   Svelte app with every Tauri `invoke` served by `src/test/fake-backend.ts`.
3. **Cluster tests** against kind (`tests/*.rs`, `#[ignore]`d, temp
   namespaces), including a namespace-scoped user.
4. **Real-app QA** on WebKitGTK through tauri-driver (`desktop/e2e/qa.sh`,
   scenarios in `desktop/e2e/qa/`, nightly `qa.yml`, per-branch runs with a
   `scenario` input), with screenshots that someone actually looks at.

A desktop change is done only with a real-app scenario (see `CLAUDE.md`,
"Definition of done").

## Consequences
- Slower PRs, fewer regressions; flaky timing in layer 3/4 must be fixed at the
  root (wait for preconditions), not retried away (#91).
- Windows (WebView2) and macOS (WKWebView) still need real coverage (#93, a
  Windows test machine; macOS checks are manual).
