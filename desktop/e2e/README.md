# Real-app E2E tests (WebKitGTK)

These tests run the built desktop app, with real IPC, watches, logs and exec,
against the kind test cluster. [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/)
proxies WebDriver to `WebKitWebDriver`, so they only run on Linux. The UI tests
with a fake backend are in `desktop/ui-src/src/test/`. Both suites use the same
`data-testid` attributes.

- `smoke.test.mjs` is the smoke suite (`node:test` + `selenium-webdriver`). It
  covers the Overview, the Pods list, a live delete and replace, pod logs, the
  terminal, saving YAML, workload logs, scaling from the context menu and a
  second window on the same context (#45). It
  reads the shared demo objects but never changes them. The objects it changes
  live in a temporary `e2e-*` namespace, which it deletes when it finishes.
- `qa/*.test.mjs` are the QA scenarios, run by `qa.sh` (below).
- `bench.mjs` is the 10k-row table benchmark (`ui-src/bench.html`) running in
  the app's webview. It only reports numbers and never fails on slow ones.

Every test saves a screenshot and the page text to `artifacts/` as
`smoke-NN-<test>.png` and `.txt`, whether it passes or fails. The app's log
goes to `artifacts/smoke-app.log`. CI uploads the whole folder as the
`e2e-screenshots` artifact on every run:

```sh
gh run download <run-id> -n e2e-screenshots
```

## QA harness: `qa.sh` and `qa/*.test.mjs`

The QA scenarios in `qa/` check the manual items from the PRs (#83) against
the real app. `qa.sh` runs them, or the smoke suite, without sudo:

```sh
desktop/e2e/qa.sh terminal                  # one scenario: qa/terminal.test.mjs
desktop/e2e/qa.sh --no-build port-forward helm
desktop/e2e/qa.sh                           # every qa/*.test.mjs
desktop/e2e/qa.sh smoke.test.mjs            # the smoke suite
KUBELOUPE_LIMITED_KUBECONFIG=~/.kube/kubeloupe-limited.yaml desktop/e2e/qa.sh limited-user
```

It:

- uses `WebKitWebDriver`, `Xvfb`, `tauri-driver` and `helm` from the system
  when they are there, and otherwise fetches them once into
  `~/.cache/kubeloupe-qa` (`KUBELOUPE_QA_CACHE`): the driver and Xvfb with
  `apt-get download` + `dpkg-deb -x` (the driver's version matches the
  installed WebKitGTK), tauri-driver with `cargo install --root`, helm from
  get.helm.sh, xclip from its `.deb` if neither xclip nor xsel is installed.
  `--tools-only` just fetches them and prints the paths.
- builds the app with the frontend embedded (skip with `--no-build`).
- starts its own Xvfb (a free display; nothing shows on your desktop, and
  its clipboard is separate) and a free tauri-driver port, so several
  worktrees can run at once.
- writes to `--out` (default `artifacts/qa-<date>-<time>/`): a screenshot
  and the page text after every test (`<scenario>-NN-<test>.png` / `.txt`),
  the app's log (`<scenario>-app.log`), `run.log`, `results.jsonl` and
  `report.md`, a summary table with the failures and screenshots per
  scenario. **Look at the screenshots**, not only at the assertions.
- stops everything it started on exit, Ctrl+C included (Xvfb, the drivers,
  every app), and unpauses a control plane a scenario paused.

Each app gets a private home (`lib/profile.mjs`): its own `HOME`, so its own
`~/.config/com.kubeloupe.app/settings.json` and `~/Downloads`, and an
`xdg-open` that only records URLs. Your own settings are never read or
changed, and no browser opens. The login shell environment import is off
(`KUBELOUPE_NO_SHELL_ENV=1`) unless a scenario asks for it.

### Helpers

| need | helper | example scenario |
| --- | --- | --- |
| start the app with a kubeconfig, contexts or env | `launch(name, { kubeconfig, contexts, env, profile, shellEnv })` (`lib/app.mjs`) | `limited-user` (KUBECONFIG), `local-shell` (SHELL, HOME) |
| one app per suite, a screenshot after each test | `appSession(name, opts)`, `waitLive(app)` (`lib/qa.mjs`) | all |
| type into xterm, read its screen, `stty size` | `terminal(app).type()`, `.screen()`, `.waitFor()`, `.run(cmd)`, `.size()` (`lib/terminal.mjs`) | `terminal`, `local-shell` |
| resize the window | `resizeWindow(app, w, h)` (`lib/window.mjs`) | `terminal` |
| several windows | `openNewWindow`, `switchTo`, `windowHandles`, `windowTitles`, `selectContext` (`lib/window.mjs`) | `multi-window` |
| close the app like a user (WM_DELETE_WINDOW, so its exit path runs; WebDriver's Close Window kills it) | `closeLikeUser(pid)` (`lib/window.mjs`, `lib/wm-close.py`), `appPid(home)` (`lib/dock.mjs`) | `area-4-node-shell` |
| the dock: tabs, panes, drag/maximize, log lines and status | `dockTabs`, `activateTab`, `closeTab`, `dockControl`, `dragDock`, `pane`, `paneTerminal`, `openPodLogs`, `logLines`, `logStatus`, `panelButton`, `pressCtrl` (`lib/dock.mjs`) | `area-4-dock`, `area-4-logs` |
| switch context without a second cluster | `aliasKubeconfig()` (`lib/dock.mjs`): the test context plus an alias of it | `area-4-dock`, `area-4-port-forwards` |
| "Open in browser" | `app.profile.opened()` (the `xdg-open` recorder) | `port-forward` |
| the clipboard | `readSystemClipboard()` (xclip / xsel / wl-paste on the app's display), `hookClipboard` + `waitForClipboard` (falls back to a page hook) (`lib/clipboard.mjs`) | `port-forward` |
| downloads | `app.profile.downloads`, `app.profile.waitForDownload(/re/)` | `logs-download` |
| restart with the same settings | `app.restart({ beforeStart })`, `app.profile.settings()`, `.writeSettings()` | `persistence` |
| pause the control plane | `withControlPlanePaused(fn, { maxMs })`, `cannotPause()` (`lib/control-plane.mjs`) | `reconnect` |
| command palette | `app.palette(query, option)` | `local-shell` |
| temp objects | `tempNamespace(prefix, yaml)`, `deleteNamespace`, `httpPodYaml`, `loggerPodYaml`, `waitPodReady`, `contexts()` (`lib/cluster.mjs`) | most |

The pause is guarded four ways, because the cluster is shared: `finally`, a
timer (`maxMs`, 60 s by default), process exit/signal handlers, and a marker
file that `qa.sh`'s exit trap unpauses from. `docker pause` needs access to
the Docker socket; without it `reconnect` is skipped with the reason. A
paused API server never answers, so the app only notices when a watch times
out (up to about 5 minutes); `QA_PAUSE_MAX_MS` caps the pause (45 s by
default, too short to see "Reconnecting…"; qa.yml, on its own cluster, uses
6 minutes).

### Writing a scenario

One file per area, `qa/<area>.test.mjs`, named after what it checks. Start
with a comment naming the PR and the checklist items it covers. Create what
you change in a temporary namespace (`tempNamespace`) and delete it in
`after`; only read the shared demo objects. When a scenario needs something
the cluster may not have (the limited user, helm, Prometheus, a second
cluster, docker access), skip it with the reason instead of failing. Use
`data-testid`s where they exist; adding one to a component is fine.

Known quirks of WebKitWebDriver: `getText()` sometimes returns nothing for
elements inside tables, so read `innerText` with `app.js(...)`; clicks need
the element fully in view (`app.nav` scrolls first); key events sent in one
WebDriver call reach the shell as separate IPC calls that can arrive out of
order, so `terminal().type()` sends one key at a time.

### Nightly in CI: `qa.yml`

`.github/workflows/qa.yml` runs nightly and on demand, not on PRs:

```sh
gh workflow run qa.yml --ref <branch>
gh run download <run-id> -n qa-artifacts
```

It sets up kind with metrics-server and the demo workload, the second
cluster (`setup.sh --staging`), the limited user, helm and a small real
Prometheus (`scripts/test-cluster/prometheus.yaml`, CI only), then runs the
smoke suite and every `qa/*.test.mjs` through `qa.sh`. The report goes to the
job summary; the screenshots, page text and logs are the `qa-artifacts`
artifact.

## Running locally

`qa.sh` above does all of this for you. By hand: you need the kind cluster (`bash scripts/test-cluster/setup.sh`), plus
`WebKitWebDriver` (Ubuntu: `sudo apt install webkit2gtk-driver`, renamed
`webkitgtk-webdriver` in newer releases), `tauri-driver`
(`cargo install tauri-driver --locked`) and, if you don't want windows opening
on your desktop, `xvfb-run` (`sudo apt install xvfb`).

```sh
# Build the app with the frontend embedded. This is what
# `cargo tauri build --debug --no-bundle` does.
npm --prefix desktop/ui-src ci
npm --prefix desktop/ui-src run build
cargo build -p kubeloupe-desktop --features tauri/custom-protocol

npm --prefix desktop/e2e ci
xvfb-run -a -s "-screen 0 1600x1000x24" npm --prefix desktop/e2e test
xvfb-run -a -s "-screen 0 1600x1000x24" npm --prefix desktop/e2e run bench   # serves ui-src with Vite on :1420
```

The app gets a kubeconfig that holds only `kind-kubeloupe-test`, so the
current context in your own kubeconfig doesn't matter. These environment
variables are optional:

| variable | default |
| --- | --- |
| `KUBELOUPE_APP` | `$CARGO_TARGET_DIR` (or `target`)`/debug/kubeloupe-desktop` |
| `TAURI_DRIVER` / `WEBKIT_DRIVER` | `tauri-driver` / `WebKitWebDriver` on `PATH` |
| `E2E_CONTEXT` | `kind-kubeloupe-test` |
| `E2E_ARTIFACTS` | `desktop/e2e/artifacts` |
| `E2E_DRIVER_PORT` | `4444` (the native driver uses the next port) |
| `BENCH_SECONDS` / `BENCH_PORT` | `30` / `1420` |

If you run several copies at once, give each its own `E2E_DRIVER_PORT` and
`BENCH_PORT`.

Rebuild the frontend before the app (`npm run build`, then `cargo build`).
The app embeds `ui-src/dist` at compile time, so a stale `dist` gives you a
UI without the current `data-testid`s.

Under Xvfb, WebKitGTK worked without `WEBKIT_DISABLE_COMPOSITING_MODE` or
`LIBGL_ALWAYS_SOFTWARE`, both on the CI runner and locally (WebKitGTK 2.50).
CI sets neither.

A plain `cargo build` without `tauri/custom-protocol` loads `devUrl`
(`http://localhost:1420`) instead of the embedded frontend. The smoke suite
doesn't start Vite, so a passing run shows that the embedded assets were the
ones loaded.
