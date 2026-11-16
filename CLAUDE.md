# Contributing to kubeloupe

Guide for people and coding agents. `AGENTS.md` is a symlink to this file.
User-facing docs are in `README.md`; the plan is the roadmap issue #24.
Why things are the way they are: `docs/decisions/`. Setting up (or
recovering) a development machine: `docs/dev-setup.md`.

## Layout

- `src/`: the core library, one module per concern (`client`, `pods`, `logs`,
  `workload_logs`, `exec`, `portforward`, `metrics`, `overview`, `watch`,
  `actions`, `cli`, `get`, `describe`), plus `src/resources/` (discovery,
  columns, table, ops, detail). `lib.rs` re-exports them. The CLI is
  `src/main.rs`, with its arguments in `src/args.rs`; `tests/cli.rs` runs the
  binary.
- `desktop/src/`: the Tauri app. `main.rs` builds the app, `state.rs` holds
  `AppState`, `commands/` has one module per concern and `commands/mod.rs`
  registers every command and event (`specta_builder`).
- `desktop/ui-src/`: the Svelte 5 + Vite + TypeScript UI.
  `src/lib/bindings.ts` is generated; `src/lib/registry.ts` lists the views,
  banners, side panels and dialogs `App.svelte` shows; `src/test/` is the fake
  backend (handlers in `src/test/fake/`, one file per command module) and the
  Playwright tests.
- `desktop/e2e/`: the real app on WebKitGTK (tauri-driver): the smoke suite,
  the QA scenarios in `qa/`, their helpers in `lib/` and `qa.sh`.
- `tests/cluster.rs`: integration tests against the kind cluster.
- `scripts/test-cluster/`: `setup.sh` (kind cluster, metrics-server),
  `demo.yaml` (the demo workload), `wait-demo.sh` (waits until the demo pods
  are in the state the tests expect), `limited-user.sh` (a namespace-scoped
  user, opt-in) and `prometheus.yaml` (CI only, see below).
- `scripts/dev/`: `capped.sh` (run a command under a memory ceiling) and
  `clean-worktrees.sh` (remove merged agent worktrees).

## Rules

- Kubernetes logic goes in `src/` so the CLI can use it too. Tauri commands
  stay thin wrappers that return `Result<T, String>`.
- Keep error messages plain and specific: say what was not allowed, what is
  already gone, what blocked it.
- Keep files small and one concern per module; parallel branches collide in
  big files.

## Checks (what CI runs)

Run all of these before opening a PR:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p kubeloupe-desktop export_typescript_bindings   # then commit bindings.ts if it changed

cd desktop/ui-src
npm ci
npm run build
npm run check        # svelte-check, 0 errors and 0 warnings
npm test             # Vitest unit tests
npx playwright test  # app tests in Chromium against the fake backend
```

On Linux the Rust checks need the WebKitGTK libraries listed in the README.
Playwright needs a browser once: `npx playwright install chromium` (add
`--with-deps` to install its system libraries too).

`integration.yml` runs the cluster tests (below) on every PR as well.

## IPC bindings

- tauri-specta generates `desktop/ui-src/src/lib/bindings.ts` from the
  commands and events. Never edit it by hand. CI fails if it is stale.
- On a merge or rebase conflict in `bindings.ts`, take either side and
  regenerate it with `cargo test -p kubeloupe-desktop export_typescript_bindings`.
  `.gitattributes` marks it `-merge` (git never merges it: a conflict means take
  either side and regenerate) and `linguist-generated`
  (collapsed in PR diffs). Always regenerate after a merge or rebase.
- Commands and events are registered in `specta_builder` in
  `desktop/src/commands/mod.rs`, sorted by module and name, one per line,
  with a trailing comma. Add a new one at its sorted place, never at the
  end: `bindings.ts` lists the commands in that order, so two branches that
  add commands to different modules touch different lines of both files.
- Avoid `Option` fields in command and event output types where you can.
  Otherwise specta splits the type into separate Serialize and Deserialize
  variants in TypeScript.
- Types in `src/` that cross the IPC boundary derive
  `#[cfg_attr(feature = "specta", derive(specta::Type))]`, so the core and
  the CLI build without specta.
- A new command also needs a fake handler, in the file of its module in
  `desktop/ui-src/src/test/fake/` (`commands/helm_charts.rs` ->
  `fake/helm-charts.ts`); `npm run check` fails in `fake/index.ts` until it
  has one. The header comment of `src/test/fake-backend.ts` explains how to
  add commands and events.

## Svelte

- Keep large collections in `$state.raw` or a plain `Map`, never deep `$state`.
- Tables use `VirtualList` (`lib/components/VirtualList.svelte`) and
  `KeyedStore` (`lib/stores/keyed.svelte.ts`).
- Components that start a stream (logs, exec, port-forward, watch) stop it
  in `onDestroy`.
- A new view, banner, side panel or dialog goes at the end of its list in
  `lib/registry.ts`, not into `App.svelte`.
- Put pure logic in `lib/*.ts` next to a `*.test.ts`. Tests of modules that use
  runes are named `*.svelte.test.ts`.

## Frontend tests

In `desktop/ui-src`:

- `npm test`: Vitest, for `src/**/*.test.ts`.
- `npm run test:e2e` (same as `npx playwright test`): the real UI
  (`test.html`) in Chromium, with every Tauri `invoke` served by the fake
  backend in `src/test/fake-backend.ts` from the fixtures in
  `src/test/fixtures/`. Tests live in `src/test/e2e/`. Its Vite server uses
  port 1430, so it runs next to `cargo tauri dev` (1420), but only one
  worktree at a time can run it ("1430 is already used" means another one is).
- `PW_CHANNEL=chrome npx playwright test` uses an installed Google Chrome if
  the Playwright browser download is blocked.
- `test.html` must never end up in `dist/`; CI checks this.

## Real-app QA (WebKitGTK)

The UI tests above run Chromium against a fake backend. To check something
in the real app (real IPC, the WebKitGTK webview, the cluster), use the QA
harness; `desktop/e2e/README.md` has the details and the helper list.

- `desktop/e2e/qa.sh <scenario>` builds the app and runs
  `desktop/e2e/qa/<scenario>.test.mjs` (none: all of them;
  `smoke.test.mjs`: the smoke suite). No sudo: WebKitWebDriver, Xvfb,
  tauri-driver and helm come from the system or are fetched once into
  `~/.cache/kubeloupe-qa`. `--no-build` reuses the built app.
- Output: `desktop/e2e/artifacts/qa-<time>/` (or `--out`): a screenshot and
  the page text per test, app logs and `report.md`. Look at the screenshots.
- Each app gets its own `HOME` (settings, Downloads, an `xdg-open` that only
  records URLs) and Xvfb display, and everything is stopped on exit.
- New checks go in `desktop/e2e/qa/<area>.test.mjs`, one area per file, with
  their objects in a temp namespace. Skip (with the reason) what needs
  something the cluster may not have.
- `qa.yml` runs them nightly and on `gh workflow run qa.yml --ref <branch>`,
  with a second cluster, helm, the limited user and a small Prometheus
  (`scripts/test-cluster/prometheus.yaml`). Don't apply that file to the
  shared local cluster: the cluster tests expect no Prometheus there.
- The `reconnect` scenario pauses the control plane (`docker pause`, always
  unpaused; at most 45 s locally, `QA_PAUSE_MAX_MS`); it skips without
  access to Docker.

## Cluster tests

- kind only. `bash scripts/test-cluster/setup.sh` creates the cluster
  (context `kind-kubeloupe-test`).
- `cargo test -- --ignored --test-threads=4` runs `tests/cluster.rs`.
  On a fresh cluster run `bash scripts/test-cluster/wait-demo.sh` first (CI
  does): it waits for `demo/crashed`'s first restart and the logger's first
  line. Tests that read the state of a demo pod still poll for it with a
  bound (`eventually`), never assume it: `demo/crashed` is only a problem
  between two runs of its container. Run one
  test with `cargo test --test cluster -- --ignored <name>`. Set
  `KUBELOUPE_TEST_CONTEXT` to use another context.
- New cluster tests are `#[ignore]`d and create what they need in a temporary
  namespace (`in_temp_ns`), which they delete afterwards.
- `tests/helm_cluster.rs` needs `helm` (on `PATH`, or the binary in
  `KUBELOUPE_HELM`); it skips without it, except in CI. It installs
  `scripts/test-cluster/charts/demo-chart` in a temporary namespace.
  `tests/helm_charts_cluster.rs` serves that chart as a repository on
  127.0.0.1 and sets `HELM_CONFIG_HOME`/`HELM_CACHE_HOME`/`HELM_DATA_HOME` to
  temporary directories: tests must never change the developer's own helm
  repositories.
- The demo objects are shared: don't change `demo/web`, `demo/logger`,
  `demo/crashed`, `demo/multi` or `default/hungry`.
- Node-level tests (cordon, drain) affect the whole cluster. They restore the
  node afterwards and only evict pods they created (`--pod-selector`).
- RBAC: `bash scripts/test-cluster/limited-user.sh` creates a ServiceAccount
  with `edit` in `team-a` only and writes a separate kubeconfig,
  `~/.kube/kubeloupe-limited.yaml` (it never touches `~/.kube/config`). The
  `limited_*` tests run as that user when
  `KUBELOUPE_LIMITED_KUBECONFIG=~/.kube/kubeloupe-limited.yaml` is set, and
  skip otherwise. Try the app as that user with
  `KUBECONFIG=~/.kube/kubeloupe-limited.yaml cargo tauri dev`. The token
  lasts 24h; re-run the script to refresh it.

## Parallel agents

- Work in your own git worktree (`.claude/` is git-ignored for this). Don't
  take on two issues that change the same component or command module at the
  same time; each issue lists the files it touches.
- Give each worktree its own cargo target dir (the default `target/` inside
  the worktree). A shared `CARGO_TARGET_DIR` makes parallel builds overwrite
  each other's artifacts.
- All agents share one kind cluster. Keep tests in their own namespaces, and
  don't run two node-level tests at once.
- Shared files take append-only or sorted lists, one entry per line with a
  trailing comma: `mod`/`use` lists, `specta_builder` in
  `desktop/src/commands/mod.rs`, `desktop/ui-src/src/test/fake/index.ts` and
  `desktop/ui-src/src/lib/registry.ts`. Put the rest in a file of your own
  area (a command module, a `fake/<module>.ts`, a component).
- Leave `README.md` out of feature PRs: the coordinator collects the user
  docs of a wave in one separate docs PR. Put what the README should say in
  your PR body.
- Name scratch files uniquely (prefix them with your issue number). Agents
  share a scratch directory, and a generic `pr.md` has been overwritten by
  another agent and pushed as the wrong PR body.

### Machine resources

The dev box is small (4 cores, 15 GB RAM). Builds of this workspace and real-app
runs (Xvfb + WebKitGTK) each take several GB; five at once got the whole
session killed by systemd-oomd.

- At most **two** agents should build or run the app at the same time;
  `scripts/dev/capped.sh` enforces it with two build slots. Check `free -h`
  before a build; wait if "available" is under ~4 GB.
- Run heavy commands under a memory ceiling, so a runaway one is killed alone:
  `scripts/dev/capped.sh cargo test --workspace`,
  `CAP=4G scripts/dev/capped.sh desktop/e2e/qa.sh <scenario>`.
- Builds already share compiled dependencies through `sccache` and run two
  rustc jobs at a time (user cargo config); don't override that.
- Each worktree's `target/` grows to several GB. When your PR is merged, the
  coordinator removes merged worktrees with `scripts/dev/clean-worktrees.sh
  --yes` (dry run without `--yes`).

### Agent roles and the merge gate

Agent definitions live in `.claude/agents/`: `coordinator` (start a session
with `claude --agent coordinator`), `dev` (one issue per worktree), `qa`
(real-app checks per area), `reviewer` (read-only pre-merge review) and
`security` (read-only security review).

- `main` is protected: the CI checks must pass, but branches don't have to be
  up to date with `main`. Merge with `gh pr merge --auto --squash`; update a
  branch only when it really conflicts; if `main` breaks, revert first.
- Before merging a feature or fix PR: a `reviewer` verdict of "merge", and for
  desktop changes a QA scenario run in CI
  (`gh workflow run qa.yml --ref <branch> -f scenario='<names>'`) whose
  screenshots someone looked at.
- PRs that touch `desktop/capabilities/`, `desktop/tauri.conf.json`,
  `.github/workflows/`, `src/exec.rs`, `src/client.rs`, helm (`src/helm/`,
  `desktop/src/commands/helm*.rs`), the local shell or the updater also need
  a `security` verdict of "merge". A full `security` pass on `main` runs
  before each release; its findings are filed as issues labelled `security`.
- Heavy commands go through `scripts/dev/capped.sh`, which waits for one of
  two build slots and caps memory.
- Agents act through the maintainer's GitHub account. Only the coordinator
  closes, reopens or merges issues and PRs; other agents never close or
  reopen anything, and never touch PRs or issues they didn't create.
- A SessionStart hook (`.claude/settings.json`) removes merged, clean agent
  worktrees.

## Definition of done

A change to the desktop app is done when:

1. The CI checks above pass, including the cluster tests.
2. Playwright tests (fake backend) cover the new UI.
3. **A real-app QA scenario** in `desktop/e2e/qa/` exercises the feature in
   WebKitGTK against kind, and you ran it with `desktop/e2e/qa.sh` and
   **looked at the screenshots** (layout at 1280x800, light and dark theme,
   empty and error states). Say in the PR which scenario and what you saw.
4. Anything you could not check (macOS, Windows, real managed clusters) is
   listed under **Not verified**.

Bugs found in your own feature are fixed in the same PR, not filed for later.

## Branches and PRs

- Start from an up-to-date `main`. Branch name: `issue-<number>-<short-name>`.
- PR body sections: **What**, **Design**, **Verified** (the exact commands you
  ran and their results), **Not verified** / manual testing checklist, then
  `Closes #<number>`.
- Say plainly what you could not verify, for example clicking through the GUI
  or behaviour in WebKitGTK (Playwright runs Chromium, not the real webview).
