# kubeloupe

[![CI](https://github.com/pedrosanzmtz/kubeloupe/actions/workflows/ci.yml/badge.svg)](https://github.com/pedrosanzmtz/kubeloupe/actions/workflows/ci.yml)

A Lens alternative written in Rust: a Kubernetes IDE that stays fast while
streaming logs and watching cluster state. It comes as a desktop app (Tauri +
Svelte) and a CLI, both built on the same Rust core.

> **Status:** early. The desktop app browses every resource type the cluster
> serves (CRDs included) with live watches, shows logs for pods and whole
> workloads, opens terminals and port-forwards, edits YAML with server-side
> apply, and runs the common actions (scale, restart, cordon, drain, trigger,
> suspend, delete). There is no tagged release yet. What comes next is tracked
> in the [roadmap (#24)](https://github.com/pedrosanzmtz/kubeloupe/issues/24).

## Desktop app

- **Every resource type**, built-in or custom, found through API discovery
  and grouped in a Lens-style sidebar (workloads, network, config, storage,
  cluster, access control, custom resources with their definitions). Kinds
  you aren't allowed to list are greyed out. Roles and bindings show their
  rules, the role they grant and their subjects, as links.
- **Live tables**: lists are kept up to date by Kubernetes watches, not by
  polling, and stay smooth with thousands of rows. Show one namespace, several
  at once (up to 10, one watch each) or all of them.
  The filter box above every list matches any column. **Aa** matches case,
  **.\*** takes a regular expression (`^` and `$` match at the start and end
  of each column; a regex that runs too long is stopped). Enter remembers a
  search and ☆ stars it; ArrowDown in the box offers your starred and recent
  searches in any list. **Export CSV** in the toolbar saves the rows and
  columns you see (filter, sort and column choice) to a file you pick. Cells
  a spreadsheet would run as formulas are written as text, and Secrets export
  only their names, types and key counts, as the table shows them.
  Pods and Nodes show CPU/memory usage when the metrics API is available,
  with a small trend line of the last 30 minutes. The pod and node detail
  panels chart CPU and memory (pods per container too) against requests and
  limits, or allocatable. metrics-server keeps no history, so the trend starts when a
  view that shows metrics opens. When the cluster has a Prometheus (found by
  its usual Service names or the `app.kubernetes.io/name=prometheus` label, or
  set per context in Settings), the charts show the last 1h, 6h or 24h from
  it, queried through the API server's service proxy (needs `get` on
  `services/proxy` in its namespace). Otherwise they say why and show the
  metrics-server history. Without a Prometheus, Settings → Prometheus offers
  to install a small one (Prometheus, kube-state-metrics, node-exporter, in
  `monitoring`, no persistent volume by default). With Prometheus and
  node-exporter, Nodes get a Disk column.
- **Overview**: pod counts (crash-looping pods count as errors, not as
  running), problem pods, CPU/memory/pod capacity against requests and usage,
  and the newest warning events, each linking to its object. Kept live by
  watches, not by re-listing the cluster. Without metrics-server it offers to
  install it (in `kube-system`). On kind and other clusters whose kubelets
  have self-signed certificates, tick "Skip kubelet TLS verification".
  Both installs run the `helm` CLI with a chart pinned to an exact version
  from the project's own repository (never added to your helm repositories),
  with editable values, a dry run first and nothing changed until you confirm.
- **Workloads → Overview**: Pods, Deployments, DaemonSets, StatefulSets,
  ReplicaSets, Jobs and CronJobs counted by status (running, pending, failed,
  succeeded, suspended, ...) in the selected namespaces, live. A click on a
  count opens that kind's table showing just those rows. It also lists the
  problem workloads (not all replicas ready, failed jobs, suspended cron jobs)
  and the newest warnings about workloads. The detail panels of Deployments,
  StatefulSets, DaemonSets, ReplicaSets and Jobs chart the summed CPU and
  memory of their pods against their summed requests and limits, from the
  metrics-server history or Prometheus.
- **Applications** (Workloads → Applications): workloads grouped by Helm
  release and by the `app.kubernetes.io/instance` (or `name`) label, per
  namespace, with their components, version and a rolled-up status. Click one
  to see its workloads and open them, or its Helm release.
- **Details** for any object. For pods: live logs (pick the container, or the
  previous instance of a crashed one) and an interactive terminal (pod exec).
  The panel's header has icon buttons for the object's actions (Logs, Shell,
  Edit, Delete, and for example Scale and Restart on workloads or Cordon and
  Drain on nodes). Actions your RBAC does not allow are greyed out, and the
  tooltip says which permission is missing.
- **Log search**: match case (Aa) and regex (.\*); Highlight keeps every line
  and steps through the matches with Enter / Shift+Enter, or n / N in the
  log. Jump to time goes to a time of day or date (needs Timestamps).
- **Secret and ConfigMap data**: the detail panel lists the keys. Secret
  values stay hidden until you reveal one key. Copy, edit, add or remove
  keys, then Save: only the changed keys are sent (a merge patch). If
  someone else changed the object meanwhile, you choose to reload or to save
  your keys over it. Binary values show as base64. Without permission to
  patch, or for an immutable object, the data is read-only.
- **Port forwards** to pods, Services and workloads, on a chosen or automatic
  local port. A Service forward picks a ready pod for each connection, so it
  keeps working when pods restart. Forwards are saved per cluster: they keep
  running when you close panels, stop when you switch that window's context
  or close it, and come back stopped, or running if you checked *Start
  automatically*. Network → Port Forwards lists them with their current pod
  and status, and starts, stops, edits and deletes them. Check *https* for
  targets that speak TLS (the URL becomes https://), and *Open in browser* to
  open the URL whenever it starts.
- **Workload logs**: follow every pod of a Deployment, StatefulSet, DaemonSet
  or Job in one stream, including pods that a rollout replaces.
- **Dock**: logs and terminals open in tabs at the bottom of the window, so
  several run at once and keep running when you close the panel or switch
  views. Open them from a panel or the right-click menu (Logs, Shell); drag
  the top edge to resize, double-click a tab to maximize, Ctrl+` or
  Ctrl+J (⌘J on macOS) to hide or show it. Ctrl+` is the key left of 1 (or
  next to the left Shift), so it also works on layouts where the backtick is
  a dead key. On Linux and Windows, Ctrl+J inside a terminal goes to the
  shell; use Ctrl+` there. At most 10 log streams run at once. Links a
  terminal prints (OSC 8) open in your browser when they are http or https;
  other links are ignored. Ctrl+Shift+F (⌘F on macOS) searches a terminal's
  output: Enter / Shift+Enter for next / previous, Aa for match case, Esc to
  close. Plain Ctrl+F still goes to the shell.
- **Local terminal** (Ctrl+Shift+` or Ctrl+Shift+J (⇧⌘J on macOS), the
  dock's `+` or "New local terminal" in the palette): your own shell
  (`$SHELL -l`; on Windows `pwsh`, `powershell` or `cmd`) in your home
  directory, with `kubectl` and `helm` already pointed at the app's context
  and namespace. The app writes a temp kubeconfig, `kubeloupe-shell-*.yaml`
  in the system temp directory, so your own kubeconfig files are never
  changed. For a context of your default kubeconfig it holds just that
  context entry and comes first in `KUBECONFIG`, before your own files. For
  a context of an added kubeconfig it is a private copy of that one context,
  made when its login was checked, and the shell sees only it: `kubectl
  config use-context` can't switch to the file's other contexts, and changes
  to the added file apply after the next check. That copy can hold the
  context's credentials (for example a token written in the file). On Linux
  and macOS the file is readable only by you (mode 0600); on Windows no mode
  is set, so who can read it depends on the temp folder's permissions. It is
  deleted when
  the tab closes or the app exits; after a crash, the next start deletes it
  (except on Windows, where leftover files can be deleted by hand). Helm
  actions on an added kubeconfig use the same kind of copy, deleted when the
  command ends. The tab shows
  `<context> · <namespace>`; changing the app's namespace later does not
  change shells that are already open.
- **YAML editor** with server-side apply. After saving, it tells you which
  fields it took over from other field managers (for example from
  `kubectl` or a controller). Secret values stay hidden until you reveal them.
  Closing a window or quitting with unsaved edits asks first (Keep editing /
  Discard changes).
- **Create from YAML** ("+ Create"): one or many documents, from a template
  for the current kind, a file you open or drop. Validated with a server dry
  run first; the results are listed per object.
- **Actions** from the row menu, the detail panel or on several selected rows:
  scale, rollout restart, cordon/uncordon, drain (with progress, respecting
  PodDisruptionBudgets), trigger/suspend/resume a CronJob, delete and force
  delete. Destructive ones ask for confirmation and list the exact objects.
- **Debugging**: "Debug…" on a pod adds an ephemeral debug container
  (`busybox:1.37` by default, or e.g. `nicolaka/netshoot`) that sees a chosen
  container's processes, and attaches to it in a dock tab. It works on images
  without a shell; the container stays in the pod until the pod is deleted.
  "Shell" on a node opens a root shell on the host through a privileged pod
  in `kube-system`, deleted when the tab closes or the app quits.
- **Keyboard first**: a command palette (Ctrl+K / Cmd+K) jumps to any kind
  (`deploy`, `svc`, `cm` work), namespace, context or object and runs
  actions (`>`); `ns ` and `ctx ` narrow it to namespaces or contexts, and
  `win ` ("Open context in new window…") opens a context in a new window.
  Arrow keys or j/k move through the table, Enter opens, Space selects,
  Delete deletes, Shift+F10 opens the row menu, `/` focuses the filter and
  `?` lists every shortcut. F5 or Ctrl+R (⌘R on macOS) refreshes the current
  view; it never reloads the window. Inside a terminal, F5 and Ctrl+R go to
  the shell. Ctrl+= / Ctrl+- / Ctrl+0 (⌘ on macOS) zoom in, zoom out and
  reset the zoom. Alt+← / Alt+→ (⌘[ / ⌘] on macOS), the mouse's back and
  forward buttons or the header arrows move back and forward through the
  views, namespaces and objects you visited in this window; switching
  context clears that history.
- **Helm releases**: a Helm section lists releases with their chart, app
  version, revision and status, read straight from the cluster (no `helm`
  binary needed; the list reads only labels). The detail shows notes,
  values (optionally merged with the chart defaults), the rendered manifest
  (Secret values hidden until you reveal them), the revision history with a
  diff of any two revisions, and the objects the release created. Rollback
  and uninstall run the `helm` CLI (on `PATH`) against the same context, after
  a confirmation.
- **Helm charts**: Helm → Charts lists the charts in your chart repositories
  (the same ones as the `helm` command line), with each version's README and
  default values. Add, update and remove repositories there or in Settings.
  Install a chart with edited values into a namespace (created if missing),
  or upgrade a release from its detail with edited values and a chosen
  version; both show a server-side dry run first (the rendered manifest, or a
  diff against the current revision) and run nothing until you confirm.
- **Multi-cluster**: switch between your kubeconfig contexts from the header,
  or open a context in its own window (the button next to the context
  selector, or the palette). Each window is connected to one cluster, titled
  with its context, and has its own watches, logs, terminals and port
  forwards: switching or closing one window leaves the others alone. The
  windows open when you quit are reopened on the next start, where they were
  and at their size; "New window" opens offset from the current window. On
  macOS, closing the last window keeps kubeloupe in the Dock (that window's
  port-forwards, shells and logs stop with it); click the Dock icon to open a
  window again. kubeloupe runs once per user: launching it again (from the
  menu, a shortcut or the command line) brings the running app's window to
  the front instead of starting a second copy. On Linux this uses the D-Bus
  session bus; without one, each launch starts its own copy.
- **Cluster catalog** (the grid button next to the context selector, or
  "Go to Cluster catalog" in the palette): every context with its API
  server, user, source file, last use and status (connected, login failed,
  certificate problem, unreachable, not allowed), checked when the catalog
  opens, except the contexts below that are checked only when you click
  **Check**. Add more
  kubeconfig files or a folder of them (watched for changes), or paste a
  kubeconfig (saved as `kubeconfigs/<name>.yaml`, mode 0600, in the app's
  config directory). Each added file connects on its own; a context whose
  name is already taken shows up as `name (file name)`. Pin clusters to put
  them first in the context selector and the palette. Each cluster's
  Settings page has its display name and colour, default and accessible
  namespaces, Prometheus Service and the local terminal's working directory.
  kubeloupe only reads your kubeconfig files; removing an added file or
  folder leaves it as it is.
- **Login commands** (exec credential plugins: EKS, GKE, AKS, kubelogin, …)
  run when kubeloupe logs in. The credential is cached per plugin
  configuration (command, arguments and environment) and reused until it
  expires. The catalog checks these contexts only when you click
  **Check**. When an added kubeconfig file, folder or pasted kubeconfig logs
  in by running a command, kubeloupe shows the exact command and runs it
  only if you choose **Allow and check** (**Don't run** marks its contexts
  "Not allowed"). The answer is remembered per source and command (in
  `exec-approvals.json` in the app's config directory) until you remove the
  source; a changed command asks again. Commands from your default
  kubeconfig (`KUBECONFIG` or `~/.kube/config`) run without asking, as in
  kubectl. Contexts of an added kubeconfig that send a token file or client
  certificate/key from outside that kubeconfig's folder are also checked only
  when you click **Check**; the row lists them under "Sends local files".
- **Remembers where you were**: the last context, and per context the view
  and namespaces; per kind the table sort and hidden columns (Columns
  button); the detail panel width (drag its left edge); saved port forwards
  and the filter's recent and starred searches. The Settings page
  (gear in the header, Ctrl+, / Cmd+,) has the theme (System, Dark, Light),
  the log viewer defaults, and **Zoom and text**: the window zoom (50–200%)
  and the terminal font size (8–32 px), both remembered; a new font size
  applies to open terminals at once. Saved in `settings.json` in the app's config
  directory (`~/.config/com.kubeloupe.app/` on Linux,
  `~/Library/Application Support/com.kubeloupe.app/` on macOS,
  `%APPDATA%\com.kubeloupe.app\` on Windows).
- **Help and diagnostics**: the Help menu (the `?` in the header; on macOS
  also in the menu bar) has Documentation, Report a bug (opens a GitHub issue
  with the version, commit, OS and webview filled in), Open log folder and
  About. Settings → About shows the version and commit and has Copy
  diagnostics (nothing about your clusters). The app log is
  `kubeloupe.log` in `~/.local/share/com.kubeloupe.app/logs/` on Linux,
  `~/Library/Logs/com.kubeloupe.app/` on macOS and
  `%LOCALAPPDATA%\com.kubeloupe.app\logs\` on Windows. It is rotated at
  2 MiB (3 files kept); on Linux and macOS only you can read it (mode 0600).
  Secret-looking text is masked, but check the log before you share it.
  `KUBELOUPE_LOG=debug` logs more.

## CLI

The CLI uses the current kubeconfig context. Every command takes
`--context NAME` and `--kubeconfig PATH` to use another context or file, so
one script can work against several clusters. Run `kubeloupe --help` or
`kubeloupe <command> --help` for every option; `kubeloupe --version` prints
the installed version.

Output is meant for scripts too: results go to stdout, errors and log lines
to stderr (no colour unless stderr is a terminal), a failure exits with
status 1 and a usage error with 2. `get` with nothing to list prints
"No resources found" on stderr and nothing on stdout. Commands on one named
object (`describe`, `yaml`, `get <kind> <name>`) default to the context's
namespace; lists default to all namespaces. Table columns are sized to their
content and two spaces apart; use `get -o name|json|yaml` for output to parse.
`exec` exits with the remote command's exit code, like `kubectl exec` (1 if
the command cannot be run).

| Command | What it does |
|---|---|
| `kubeloupe get <kind> [<name>] [-n NS] [-o FORMAT] [-l SEL] [--field-selector SEL]` | List any resource type, built-in or custom (`deploy`, `svc`, `widgets.example.com`), with the same columns as the app. `-o` is `table` (default), `wide` (adds labels, and IPs for pods and nodes), `yaml`, `json` or `name` (`deployment.apps/web`). Also `get <kind>/<name>` |
| `kubeloupe describe <kind>/<name> [-n NS]` | Metadata, owners, labels and annotations, conditions, Secret keys (never values) and events of any object, like `kubectl describe` |
| `kubeloupe yaml <kind>/<name> [-n NS] [--reveal]` | Print any object as YAML. Secret values are hidden unless `--reveal` is given (same for `get -o yaml\|json`). `yaml <pod>` is short for `yaml pod/<pod>` |
| `kubeloupe helm list [-n NS]` | Helm releases with chart, app version, revision and status (all namespaces by default), read from the cluster without `helm` |
| `kubeloupe helm get <release> [all\|values\|manifest\|notes\|history] [-n NS] [--revision N] [--all] [--reveal]` | One release: a summary with history and notes (default), its user values (`--all` merges the chart defaults), manifest (Secret values hidden unless `--reveal`), notes or revisions |
| `kubeloupe completions <bash\|zsh\|fish\|powershell\|elvish>` | Print a shell completion script, e.g. `kubeloupe completions bash > ~/.local/share/bash-completion/completions/kubeloupe` |
| `kubeloupe watch [<kind>] [-n NS]` | Print live changes to a resource type (default `pods`) until Ctrl-C |
| `kubeloupe pods [-n NS]` | List pods (all namespaces by default) |
| `kubeloupe namespaces` | List namespaces |
| `kubeloupe nodes` | List nodes with readiness and kubelet version |
| `kubeloupe logs <pod> [-n NS] [-c CONTAINER] [-p] [-f] [--tail N]` | A pod's logs: `-c` picks a container, `-p` the previous (crashed) instance, `-f` follows |
| `kubeloupe logs deploy/<name>` (also `sts/`, `ds/`, `job/`) | The logs of every pod of a workload, as `[pod] line` |
| `kubeloupe top [pods\|nodes] [-n NS]` | CPU/memory usage (needs metrics-server); `-n` limits pods to one namespace |
| `kubeloupe exec <pod> [-n NS] [-c CONTAINER] -- <command>` | Run a command in a pod and print its output; exits with the command's exit code |
| `kubeloupe debug <pod> [-n NS] [-c CONTAINER] [--image IMAGE]` | Add an ephemeral debug container (default `busybox:1.37`) that shares the container's processes, and attach to it. Works on images without a shell; the container cannot be removed afterwards |
| `kubeloupe node-shell <node> [-n NS] [--image IMAGE]` | A root shell on a node through a privileged pod (in `kube-system` by default; it needs Pod Security `privileged`). The pod is deleted when the shell exits |
| `kubeloupe port-forward <target> <[local:]remote>... [-n NS]` | Forward to localhost until Ctrl-C. Target: a pod name, `svc/<name>`, `deploy/<name>` (also `pod/`, `sts/`, `rs/`, `ds/`). Ports: `8080:80`, `:80` (random local), or `80` (the same local port if free and ≥ 1024, else random); the remote port may be a port name |

Actions report errors in plain words (not allowed, already gone, blocked by a
PodDisruptionBudget). Namespaced actions default to the `default` namespace.

| Command | What it does |
|---|---|
| `kubeloupe scale <deploy\|sts\|rs>/<name> --replicas N [-n NS]` | Set the replica count |
| `kubeloupe restart <deploy\|sts\|ds>/<name> [-n NS]` | Rollout restart |
| `kubeloupe cordon <node>` / `kubeloupe uncordon <node>` | Mark a node unschedulable / schedulable |
| `kubeloupe drain <node> [--timeout SECS] [--pod-selector SEL]` | Cordon, then evict the node's pods through the Eviction API with progress output. Skips DaemonSet and mirror pods and retries evictions a PodDisruptionBudget refuses |
| `kubeloupe trigger cronjob/<name> [-n NS]` | Create a Job from a CronJob now |
| `kubeloupe suspend cronjob/<name> [-n NS]` / `resume cronjob/<name>` | Suspend or resume a CronJob |
| `kubeloupe delete <kind>/<name> [-n NS] [--force]` | Delete an object of any kind. `--force` (pods only) uses grace period 0 |
| `kubeloupe apply -f <file\|-> [-n NS] [--dry-run]` | Create or update the objects of a (multi-document) YAML file, like `kubectl apply`. Validated with a dry run first; nothing is applied if any object fails |

## Install

Releases will be published on the
[Releases page](https://github.com/pedrosanzmtz/kubeloupe/releases) with these
files:

- Linux: `.AppImage` (`chmod +x` it and run) or `.deb` (`sudo apt install ./kubeloupe_*.deb`)
- macOS: `.dmg` (universal, Apple silicon and Intel)
- Windows: `.msi` or the NSIS `-setup.exe`
- CLI only: `kubeloupe-cli-<version>-<target>.tar.gz` (`.zip` on Windows)

The builds are not signed yet, so the OS will warn you the first time:

- macOS: open the `.dmg` and drag the app to Applications in Finder. Don't
  run it from the disk image: macOS then runs it from a temporary read-only
  copy, which can't update itself. The first launch says "Apple could not verify…";
  click Done, then open System Settings → Privacy & Security and click
  **Open Anyway** next to the kubeloupe message (on macOS 15 and later,
  right-click → Open no longer offers this). If macOS says the app is
  damaged, run `xattr -dr com.apple.quarantine /Applications/kubeloupe.app`.
- macOS CLI: a downloaded `kubeloupe` binary is killed at launch (exit
  status 137) until you remove the quarantine flag:
  `xattr -d com.apple.quarantine ./kubeloupe`.
- Windows: SmartScreen shows "Windows protected your PC"; click
  More info, then Run anyway.
- Linux needs no workaround; the AppImage needs FUSE 2 (`libfuse2`) on
  recent Ubuntu. If the window stays blank (some GPU drivers), start it with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

### Proxies

The app and the CLI ignore `HTTPS_PROXY` (and `NO_PROXY`) from the
environment when they talk to a cluster, so a machine-wide proxy doesn't
break access to local or internal clusters. To reach a cluster through a
proxy, set `proxy-url` (an `http://` proxy) on that cluster in the
kubeconfig. `helm` and `kubectl` started from the app (Helm actions, the
local terminal) still use the environment as usual.

The app window itself loads nothing from the network: a strict Content
Security Policy allows only the app's own files and its IPC.

### Updates

The desktop app checks for a newer release once on start (turn it off in
Settings, or check by hand from Settings or the command palette). A newer
version shows a banner with its release notes and "Install and restart";
nothing is downloaded until you click it. The update is verified against the
signing key built into the app. The AppImage, the macOS app and the Windows
installers update in place; a `.deb` install does so only when the release has
a signed `.deb` update, otherwise the banner links to the release page.
On macOS, a copy run straight from the disk image, or from a temporary
location (App Translocation, when a downloaded app was not moved with
Finder), can't update itself: the banner says so and links to the release
page. Drag kubeloupe into Applications with Finder to update it in place.

## Build and run from source

You need:

- Rust (stable)
- A kubeconfig (`~/.kube/config`, or `KUBECONFIG`) pointing at a cluster, or
  in-cluster config when running inside Kubernetes
- For the desktop app: Node (the version in `desktop/ui-src/.nvmrc`), the
  Tauri CLI, and on Linux the WebKitGTK libraries
  (`sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`).
  macOS and Windows need nothing extra.

The CLI:

```sh
cargo run -- --help
cargo run -- get deploy -n kube-system
cargo run -- logs deploy/<name> -n <namespace> -f
```

The desktop app:

```sh
cargo install tauri-cli --version "^2" --locked   # once
npm --prefix desktop/ui-src ci                    # once, and after lockfile changes
cd desktop && cargo tauri dev                     # starts Vite on :1420 and the app
```

A debug build loads the UI from the Vite dev server, so
`cargo run -p kubeloupe-desktop` on its own shows a connection error unless
`npm --prefix desktop/ui-src run dev` is running. `cd desktop && cargo tauri
build` builds the UI (`npm run build` in `desktop/ui-src`) and makes a release
build with it bundled; add `--no-bundle` to skip the installers. The
installers include signed update bundles, which need the release signing key
(`TAURI_SIGNING_PRIVATE_KEY`); without it, build them unsigned with
`cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.

Debug builds never check for updates. To try the update banner, serve a
`latest.json` with a higher `version` (for example with
`python3 -m http.server` in its folder) and start the app with
`KUBELOUPE_UPDATE_ENDPOINT=http://127.0.0.1:8000/latest.json cargo tauri dev`;
release builds ignore this variable. Installing from it also needs bundles
signed with the release key.

## Test cluster

`bash scripts/test-cluster/setup.sh` creates a local test cluster with
[kind](https://kind.sigs.k8s.io/) (Kubernetes IN Docker): real nodes running
real containers, so logs, exec, port-forwarding and the CPU/memory columns
all work end to end. It needs Docker, usable by your user without `sudo`.
The script installs `kind` and `kubectl` into `~/.local/bin` if they are
missing.

It creates `kubeloupe-test` (a control-plane node and a worker) with:

- metrics-server (patched with `--kubelet-insecure-tls`, which kind's
  self-signed kubelet certs need), so the usage columns and `kubeloupe top`
  work; the numbers appear about a minute after it starts
- the demo workload (`scripts/test-cluster/demo.yaml`) in namespace `demo`:
  the `web` (nginx) and `logger` deployments (the logger writes a line every
  2 s, handy for live logs), a two-container pod (`multi`), a crash-looping
  pod (`crashed`), and in `default` a pod that stays Pending (`hungry`)

`scripts/test-cluster/charts/demo-chart` is a tiny local chart (a ConfigMap,
a Secret and a Deployment) for the Helm tests, which install it in temporary
namespaces with `helm`. `tests/helm_charts_cluster.rs` also packages it as a
chart repository served from 127.0.0.1, with helm pointed at temporary
configuration directories, so it never touches your own repositories.

Pass `--staging` to also create `kubeloupe-staging`, a single empty node, so
the context switcher has a second cluster to switch to. Each kind cluster
costs roughly 500 MB to 1 GB of RAM, which is why it is opt-in.

kind adds the contexts (`kind-kubeloupe-test`, `kind-kubeloupe-staging`) to
`~/.kube/config` and the script leaves `kind-kubeloupe-test` current.

Delete the clusters with `kind delete cluster --name kubeloupe-test` (and
`kubeloupe-staging`); re-run the script to recreate them.

## Contributing

See [CLAUDE.md](CLAUDE.md) (also available as `AGENTS.md`) for the code
layout, the checks CI runs, how to regenerate the IPC bindings, and how to run
the unit, frontend and cluster tests.

## License

MIT
