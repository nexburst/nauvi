# nauvi

[![CI](https://github.com/nexburst/nauvi/actions/workflows/ci.yml/badge.svg)](https://github.com/nexburst/nauvi/actions/workflows/ci.yml)

A Lens alternative written in Rust: a Kubernetes IDE that stays fast while
streaming logs and watching cluster state. It comes as a desktop app (Tauri +
Svelte) and a CLI, both built on the same Rust core. It lives at
[nexburst/nauvi](https://github.com/nexburst/nauvi).

Formerly kubeloupe ([why it was renamed](docs/decisions/0008-rename-to-nauvi.md)).

> **Status:** early. The desktop app browses every resource type the cluster
> serves (CRDs included) with live watches, shows logs for pods and whole
> workloads, opens terminals and port-forwards, edits YAML with server-side
> apply, and runs the common actions (scale, restart, cordon, drain, trigger,
> suspend, delete). There is no tagged release yet. What comes next is tracked
> in the [roadmap (#24)](https://github.com/nexburst/nauvi/issues/24).

## Desktop app

- **Getting around without a sidebar**: the window's left edge is a narrow
  column of **berths**, the places you keep at hand, shown by their kubectl
  short names (`po`, `dep`, `svc`) with a count of what needs attention.
  The first is always the Overview; you add up to eight more with `P` (or the
  dashed cell that offers the view on screen), remove any with its ✕ or a
  right-click, and jump with keys `1`-`9`. The app never adds one. Every
  kind is in a drawer: `G` (or the compass at the foot of the berths) opens
  it, typing a kubectl name (`po`, `deploy`, `secrets`) and Enter goes there,
  and it closes again. **Keep open** in the drawer keeps it as a column
  beside the table, the classic layout, and the handle at the left edge
  floats it again.
- **Every resource type**, built-in or custom, found through API discovery
  and grouped in that drawer (workloads, network, config, storage,
  cluster, access control, device resources, custom resources with their
  definitions). Admission policies and their bindings sit under Config.
  Device Resources holds the DRA kinds: DeviceClasses, ResourceClaims,
  ResourceClaimTemplates and ResourceSlices. Admission-policy and device
  resource kinds that the cluster doesn't serve stay in their group, greyed
  out; other kinds it doesn't serve are not listed. Kinds you aren't allowed
  to list are greyed out too. Roles and bindings show their rules, the role they grant and their
  subjects, as links.
- **Live tables**: lists are kept up to date by Kubernetes watches, not by
  polling, and stay smooth with thousands of rows. Show one namespace, several
  at once (up to 10, one watch each) or all of them.
  The filter box above every list matches any column. **Aa** matches case,
  **.\*** takes a regular expression (`^` and `$` match at the start and end
  of each column; a regex that runs too long is stopped). A leading `!`
  inverts a text filter: `!Completed` shows the rows that do not contain it.
  `Z`, or the warning mark in the toolbar, keeps only the rows that need
  attention. Enter remembers a
  search and ☆ stars it; ArrowDown in the box offers your starred and recent
  searches in any list. **Export CSV** in the toolbar saves the rows and
  columns you see (filter, sort and column choice) to a file you pick. Cells
  a spreadsheet would run as formulas are written as text, and Secrets export
  only their names, types and key counts, as the table shows them.
  Ages are printed like `kubectl get` (`7d20h`, `3h12m`); hover an Age cell,
  or open the detail panel, for the creation time (local time or UTC, per
  Settings). The Columns button's **More columns** has optional columns that
  are off by default, and **Default columns** goes back to the default set.
  For Pods these are Controlled By (a link to the owner), QoS, IP, Nominated
  Node and **Containers**: one square per container, init containers first.
  Filled green: ready; half filled amber: running but not ready, or starting;
  red with a cross: crash-looping, image pull failing, or exited with an
  error; hollow grey: completed; dashed: no status yet. Hover a square for
  the container's name, state and reason; sorting by the column puts pods
  with a broken container first.
  Deployments, StatefulSets and DaemonSets have a **Status** column that
  says what the controller is doing: Running (green), Scaling or Updating
  (amber), Failed (red: the rollout is past its deadline or a pod could not
  be created), Paused or Scaled down (grey), each with its own shape. Hover
  it for why; sort by it to see broken rollouts first.
  Every row ends in a **⋮** button with the row's actions (the same menu as
  a right-click, or Shift+F10 on the focused row). Click a **Namespace**
  cell to show that namespace only, a **Node** cell to open the node, a
  **Controlled By** cell to open the owner.
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
  node-exporter, Nodes get a Disk column. **Hide metrics** (the cluster's
  Settings → Metrics) hides CPU and memory usage for that cluster (table
  columns, charts, the Overview's usage) and stops polling its metrics API;
  a note with a link to the setting shows where the metrics would be.
- **Overview**: a headline that says how many pods need a look, then pod
  counts (crash-looping pods count as errors, not as running), problem pods, CPU/memory/pod capacity against requests and usage,
  and the newest warning events, each linking to its object. The CPU and
  Memory bars show limits next to requests, with a marker, and turn red when
  the limits exceed what the nodes can allocate. Below them, a 1-hour CPU and
  memory chart comes from Prometheus when one is found or set in Settings,
  otherwise from metrics-server samples taken while the window is open. Kept
  live by watches, not by re-listing the cluster. Without metrics-server it offers to
  install it (in `kube-system`). "Skip kubelet TLS verification" makes
  metrics-server trust any kubelet certificate: it is meant for kind and
  other local clusters with self-signed kubelet certificates, so leave it off
  elsewhere. Both installs run the `helm` CLI with a chart pinned to an exact
  version from each chart's upstream repository (kubernetes-sigs/metrics-server,
  prometheus-community), never added to your helm repositories, with editable
  values, a dry run first and nothing changed until you confirm. They create
  ClusterRoles and ClusterRoleBindings, and metrics-server also an
  APIService, so you need permission to create those. The Prometheus stack's
  node-exporter runs as a DaemonSet on every node.
- **The watch**: the dial in the title bar shows how long the cluster has
  been calm (no problem pods) or how many need a look; it opens a small
  sonar, the calm streak, the last twelve hours and a few insignia earned by
  keeping watch. The line along the status bar is the same twelve hours, with
  a brass knot where each problem cleared (hover it for what and when). It
  is kept per context in the app's local storage, counts only while the
  Overview is open, and never interrupts.
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
  Drain on nodes).
  Each container card of a pod starts with a summary: image, command, args,
  requests, limits, the number of env variables, and the mounts with what
  each volume is. Values in command lines that look like secrets
  (`--token=`, `--password`, `…PASSWORD=`, passwords in URLs) are shown as
  `••••`; env values from Secrets show only "from Secret name/key". The
  panel collapses kubectl's `last-applied-configuration` annotation: Show
  opens it with secret-looking values masked the same way; the YAML tab
  shows it as stored.
- **Log search**: match case (Aa) and regex (.\*); Highlight keeps every line
  and steps through the matches with Enter / Shift+Enter, or n / N in the
  log. Going to a match turns Follow off; check Follow to go back to the
  newest line. Jump to time goes to a time of day or date (needs Timestamps).
  **Exclude** hides the lines that match its text. **Context** shows ±N
  lines around each match. A downloaded log starts with a `#` header that
  says where the lines came from and which filter was on.
- **Secret and ConfigMap data**: the detail panel lists the keys. Secret
  values stay hidden until you reveal one key. Copy, edit, add or remove
  keys, then Save: only the changed keys are sent (a merge patch). If
  someone else changed the object meanwhile, you choose to reload or to save
  your keys over it. Binary values show as base64. Without permission to
  patch, or for an immutable object, the data is read-only. Annotations
  that copy a Secret (`last-applied-configuration`, kapp's original, any
  that repeat its values) are hidden like the values.
- **Port forwards** to pods, Services and workloads, on a chosen or automatic
  local port. A Service forward picks a ready pod for each connection, so it
  keeps working when pods restart. Forwards are saved per cluster: they keep
  running when you close panels or show another cluster, stop when you
  disconnect that cluster or close the window, and come back stopped, or running if you checked *Start
  automatically*. Network → Port Forwards lists them with their current pod
  and status, and starts, stops, edits and deletes them. Check *https* for
  targets that speak TLS (the URL becomes https://), and *Open in browser* to
  open the URL whenever it starts. A saved forward runs in one window at a
  time: other windows on that context show "Running in another window" and
  can't start it until it is stopped there. Idle connections (a database
  client between queries) stay open. After a forward starts, a banner
  offers Open and Port Forwards.
  A forward keeps one connection to each pod it forwards to and opens a
  stream on it per local connection, as kubectl does; nothing connects to
  the pod until a client does. `NAUVI_PORT_FORWARD_MULTIPLEX=0` falls back
  to one API-server upgrade per connection. New connections reuse a
  warm connection to the API server and skip TCP's delayed ACK, so on kind
  a new connection takes about 16 ms through a pod forward and 19 ms
  through a Service forward (median; it was about 57 and 60 ms, and
  `kubectl port-forward` takes about 5 ms in the same run). On a remote
  cluster that saves about two round trips per new connection.
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
  close. Plain Ctrl+F still goes to the shell. Each tab has a context line
  that says what it is attached to (pod, container, namespace, since), with
  links.
- **Local terminal** (Ctrl+Shift+` or Ctrl+Shift+J (⇧⌘J on macOS), the
  dock's `+` or "New local terminal" in the palette): your own shell
  (`$SHELL -l`; on Windows `pwsh`, `powershell` or `cmd`) in your home
  directory, with `kubectl` and `helm` already pointed at the app's context
  and namespace. The app writes a temp kubeconfig, `nauvi-shell-*.yaml`
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
  **Matching kubectl (opt-in)**: Settings → Local terminal → "Offer a kubectl
  that matches the cluster". When your kubectl is more than one minor version
  from the cluster, a new local terminal offers to download the matching
  release from dl.k8s.io. Nothing is downloaded until you click. The file is
  checked against the SHA-256 that dl.k8s.io publishes next to it: that
  proves the download is complete and is the file dl.k8s.io serves, not that
  it is signed. It is saved in the app's data folder, and local terminals
  opened later put it first on `PATH`. Your own kubectl is never replaced.
  The download uses the cluster's proxy if one is set.
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
  **Evict** on a pod goes through the Eviction API, as a drain does: if a
  PodDisruptionBudget would be violated, the eviction is refused and the
  dialog says why. It needs `create pods/eviction`. Actions you aren't
  allowed to run (per RBAC) are greyed out in the row menu, the detail panel,
  the selection bar and the command palette, and the keyboard Delete refuses
  them; the tooltip names the missing permission (for
  example *Not allowed: you can't delete pods in namespace demo*).
- **Links to objects**: **Copy link** (in the detail panel's header and the
  right-click menu) copies a `nauvi://` link such as
  `nauvi://my-context/apps/v1/Deployment/shop/web` (`core` for the core
  group, `_` for no namespace). Opening one (from a browser, a chat, or
  `xdg-open`, `open`, `start`) brings nauvi to the front and shows that
  object in a window on that context, opening one if needed. A link only
  opens a view; it never changes the cluster. Opening a context from your
  default kubeconfig may run its login plugin, as switching to it does. A
  link to a context that is not in your kubeconfigs only shows a notice.
  The Linux `.deb`, the macOS app and the Windows installers register the
  `nauvi://` scheme. The AppImage doesn't: it handles links only if you
  set up desktop integration (for example with AppImageLauncher). A build
  from source doesn't either.
- **Debugging**: "Debug…" on a pod adds an ephemeral debug container
  (`busybox:1.37` by default, or e.g. `nicolaka/netshoot`) that sees a chosen
  container's processes, and attaches to it in a dock tab. It works on images
  without a shell; the container stays in the pod until the pod is deleted.
  "Shell" on a node opens a root shell on the host through a privileged pod
  in `kube-system`, deleted when the tab closes or the app quits.
- **Verbs on the focused row**, as in k9s: `L` opens its logs, `S` a shell,
  `E` or `Y` its YAML editor, `Shift+R` restarts its workload (it always
  asks first) and `A` copies a prompt about it for your own coding agent. A
  line under the table names the keys that apply. In the detail panel, `W`
  gives the object the whole window and gives the table back; the YAML tab
  takes the whole window by itself. The panel leads with what the table says
  is wrong ("CrashLoopBackOff · 12 restarts").
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
- **Multi-cluster**: the drawer of kinds holds a tree of every kubeconfig
  context, grouped by file. Nothing connects until you use it: expand a cluster to
  connect it in the background and see its resource types, and click its
  name to show it. Several clusters stay connected in one window; tables and
  the overview watch only the one shown. Logs, terminals and port-forwards
  keep running when you show another cluster, and dock tabs, port-forwards,
  notifications and the status bar name the cluster each one runs on, in the
  cluster's colour. That colour also runs along the top edge of the window
  and shows in every confirm dialog; a read-only or protected cluster without
  a colour gets an amber or red edge. The other clusters this window is
  connected to are chips beside the context selector: click one to show it,
  ✕ to disconnect it. ✕ on a cluster's row in the tree does the same and
  stops what runs there. Click a sidebar section's title (or focus it and
  press Enter) to collapse it; nauvi remembers it. Long cloud context names
  (EKS ARNs, GKE, AKS) show the cluster name; hover for the full name.
  The status bar shows the cluster, its Kubernetes version and the time. On
  a live view this is `Live · last change <time>`: the rows are current, and
  the time is when they last changed. `Stale since <time>` means the
  connection is lost and the rows are as of that time.
  A cluster you are not looking at is disconnected after 10 minutes
  untouched (Settings → Background clusters; Never turns this off). A
  port-forward, terminal, local shell, log stream or drain keeps it
  connected. So does a login plugin that may ask you something, unless the
  kubeconfig sets `interactiveMode: Never` or the plugin is known not to ask
  (aws eks get-token without a profile, aws-iam-authenticator,
  gke-gcloud-auth-plugin, kubelogin with `--login`
  spn/msi/workloadidentity/azurecli). Using the cluster again reconnects it,
  without asking about its login command again.
  **Hide** a cluster with the eye button in the tree or the catalog's ⋯
  menu. It is only hidden in nauvi: your kubeconfig is never changed. The
  catalog's Show hidden lists hidden clusters with an Unhide button.
  You can also open a context in its own window (the button next to the
  context selector, or the palette); each window has its own clusters,
  watches, logs, terminals and port forwards, and closing one leaves the
  others alone. The windows open when you quit are reopened on the next start, where they were
  and at their size; "New window" opens offset from the current window. On
  macOS, closing the last window keeps nauvi in the Dock (that window's
  port-forwards, shells and logs stop with it); click the Dock icon to open a
  window again. nauvi runs once per user: launching it again (from the
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
  namespaces, Prometheus Service, the local terminal's working directory,
  a proxy (Network) and a read-only or protected mode (Changes).
  nauvi only reads your kubeconfig files; removing an added file or
  folder leaves it as it is.
- **Login commands** (exec credential plugins: EKS, GKE, AKS, kubelogin, …)
  run when nauvi logs in. The credential is cached per plugin
  configuration (command, arguments and environment) and reused until it
  expires. The catalog checks these contexts only when you click
  **Check**. When an added kubeconfig file, folder or pasted kubeconfig logs
  in by running a command, nauvi shows the exact command and runs it
  only if you choose **Allow and check** (**Don't run** marks its contexts
  "Not allowed"). The answer is remembered per source and command (in
  `exec-approvals.json` in the app's config directory) until you remove the
  source; a changed command asks again. In the cluster tree, such a cluster
  asks inside its own row before the command runs. Commands from your default
  kubeconfig (`KUBECONFIG` or `~/.kube/config`) run without asking, as in
  kubectl. Contexts of an added kubeconfig that send a token file or client
  certificate/key from outside that kubeconfig's folder are also checked only
  when you click **Check**; the row lists them under "Sends local files".
- **Read-only and protected clusters** (cluster Settings → Changes):
  **Protected** asks you to type the context name before every change
  (actions, deletes, edits, Helm, terminals, starting a port-forward).
  **Read-only** refuses every change, terminals included. Logs and
  port-forwards work in both. The backend enforces the mode, not only the
  UI. The header and the catalog show a badge. Switching a cluster to
  read-only closes its terminals in every window. `nauvi mcp` refuses its
  write tools on such a context.
- **Remembers where you were**: the last context, and per context the view
  and namespaces; per kind the table sort and hidden columns (Columns
  button); the detail panel width (drag its left edge); saved port forwards
  and the filter's recent and starred searches. The Settings page
  (gear in the header, Ctrl+, / Cmd+,) has the theme (System, Dark, Light),
  the log viewer defaults, and **Zoom and text**: the window zoom (50–200%)
  and the terminal font size (8–32 px), both remembered; a new font size
  applies to open terminals at once. It also has the YAML editor's font size
  and tab size, compact table rows, times in local time or UTC, Background
  clusters (above) and **Start at login** (off by default). Saved in `settings.json` in the app's config
  directory (`~/.config/com.nauvi.app/` on Linux,
  `~/Library/Application Support/com.nauvi.app/` on macOS,
  `%APPDATA%\com.nauvi.app\` on Windows).
- **Notifications**: the bell in the title bar keeps the notices and errors
  this window has shown (the last 200, until the window closes), with their
  time, context and a link to the object. It opens as a popover; Esc or a
  click elsewhere closes it, and what arrives meanwhile counts as unread.
  **Clear all** empties it.
- **When a cluster does not answer**: a view that cannot start is retried
  with a growing wait (5, 10, 20, 40 seconds, then every minute) and, after
  about five minutes, no more: the error says "Stopped retrying. Refresh to
  try again." Refresh, a context switch or opening the view again starts
  over. The error is one notification, however many retries it took. A
  view that was live and lost its connection shows Reconnecting while the
  app tries again (every second at first, every ten at most); after five
  minutes of that without a break it is stopped the same way, and what it
  showed stays on screen, dimmed. Logs, terminals and port-forwards are not
  part of this: they keep their own connections.
- **Help and diagnostics**: the Help menu (the `?` in the header; on macOS
  also in the menu bar) has Documentation, Report a bug (opens a GitHub issue
  with the version, commit, OS and webview filled in), Open log folder and
  About. Settings → About shows the version and commit and has Copy
  diagnostics (nothing about your clusters). The app log is
  `nauvi.log` in `~/.local/share/com.nauvi.app/logs/` on Linux,
  `~/Library/Logs/com.nauvi.app/` on macOS and
  `%LOCALAPPDATA%\com.nauvi.app\logs\` on Windows. It is rotated at
  2 MiB (3 files kept); on Linux and macOS only you can read it (mode 0600).
  Secret-looking text is masked, but check the log before you share it.
  `NAUVI_LOG=debug` logs more.

## CLI

The CLI uses the current kubeconfig context. Every command takes
`--context NAME` and `--kubeconfig PATH` to use another context or file, so
one script can work against several clusters. Run `nauvi --help` or
`nauvi <command> --help` for every option; `nauvi --version` prints
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
| `nauvi get <kind> [<name>] [-n NS] [-o FORMAT] [-l SEL] [--field-selector SEL]` | List any resource type, built-in or custom (`deploy`, `svc`, `widgets.example.com`), with the same columns as the app. `-o` is `table` (default), `wide` (adds labels, IPs for pods and nodes, and NOMINATED NODE for pods), `yaml`, `json` or `name` (`deployment.apps/web`). Also `get <kind>/<name>` |
| `nauvi describe <kind>/<name> [-n NS]` | Metadata, owners, labels and annotations, conditions, Secret keys (never values) and events of any object, like `kubectl describe` |
| `nauvi yaml <kind>/<name> [-n NS] [--reveal]` | Print any object as YAML. Secret values are hidden unless `--reveal` is given (same for `get -o yaml\|json`). `yaml <pod>` is short for `yaml pod/<pod>` |
| `nauvi helm list [-n NS]` | Helm releases with chart, app version, revision and status (all namespaces by default), read from the cluster without `helm` |
| `nauvi helm get <release> [all\|values\|manifest\|notes\|history] [-n NS] [--revision N] [--all] [--reveal]` | One release: a summary with history and notes (default), its user values (`--all` merges the chart defaults), manifest (Secret values hidden unless `--reveal`), notes or revisions |
| `nauvi completions <bash\|zsh\|fish\|powershell\|elvish>` | Print a shell completion script, e.g. `nauvi completions bash > ~/.local/share/bash-completion/completions/nauvi` |
| `nauvi watch [<kind>] [-n NS]` | Print live changes to a resource type (default `pods`) until Ctrl-C |
| `nauvi pods [-n NS]` | List pods (all namespaces by default) |
| `nauvi namespaces` | List namespaces |
| `nauvi nodes` | List nodes with readiness and kubelet version |
| `nauvi logs <pod> [-n NS] [-c CONTAINER] [-p] [-f] [--tail N]` | A pod's logs: `-c` picks a container, `-p` the previous (crashed) instance, `-f` follows |
| `nauvi logs deploy/<name>` (also `sts/`, `ds/`, `job/`) | The logs of every pod of a workload, as `[pod] line` |
| `nauvi top [pods\|nodes] [-n NS]` | CPU/memory usage (needs metrics-server); `-n` limits pods to one namespace |
| `nauvi exec <pod> [-n NS] [-c CONTAINER] -- <command>` | Run a command in a pod and print its output; exits with the command's exit code |
| `nauvi debug <pod> [-n NS] [-c CONTAINER] [--image IMAGE]` | Add an ephemeral debug container (default `busybox:1.37`) that shares the container's processes, and attach to it. Works on images without a shell; the container cannot be removed afterwards |
| `nauvi node-shell <node> [-n NS] [--image IMAGE]` | A root shell on a node through a privileged pod (in `kube-system` by default; it needs Pod Security `privileged`). The pod is deleted when the shell exits |
| `nauvi port-forward <target> <[local:]remote>... [-n NS]` | Forward to localhost until Ctrl-C. Target: a pod name, `svc/<name>`, `deploy/<name>` (also `pod/`, `sts/`, `rs/`, `ds/`). Ports: `8080:80`, `:80` (random local), or `80` (the same local port if free and ≥ 1024, else random); the remote port may be a port name |

Actions report errors in plain words (not allowed, already gone, blocked by a
PodDisruptionBudget). Namespaced actions default to the `default` namespace.

| Command | What it does |
|---|---|
| `nauvi scale <deploy\|sts\|rs>/<name> --replicas N [-n NS]` | Set the replica count |
| `nauvi restart <deploy\|sts\|ds>/<name> [-n NS]` | Rollout restart |
| `nauvi cordon <node>` / `nauvi uncordon <node>` | Mark a node unschedulable / schedulable |
| `nauvi evict <pod> [-n NS]` | Evict one pod through the Eviction API. A PodDisruptionBudget that would be violated refuses it (not retried) |
| `nauvi drain <node> [--timeout SECS] [--pod-selector SEL]` | Cordon, then evict the node's pods through the Eviction API with progress output. Skips DaemonSet and mirror pods and retries evictions a PodDisruptionBudget refuses |
| `nauvi trigger cronjob/<name> [-n NS]` | Create a Job from a CronJob now |
| `nauvi suspend cronjob/<name> [-n NS]` / `resume cronjob/<name>` | Suspend or resume a CronJob |
| `nauvi delete <kind>/<name> [-n NS] [--force]` | Delete an object of any kind. `--force` (pods only) uses grace period 0 |
| `nauvi apply -f <file\|-> [-n NS] [--dry-run]` | Create or update the objects of a (multi-document) YAML file, like `kubectl apply`. Validated with a dry run first; nothing is applied if any object fails |

### Use nauvi from an AI assistant (MCP)

nauvi has no model of its own and stores no API key: it works with the
coding agent you already have, which signs in itself. In the desktop app,
**Settings → Agents** shows the entry below for Claude Code, Codex, VS Code
and the clients that share the `mcpServers` form (Cursor, Claude Desktop,
Gemini CLI, Windsurf), pinned to the cluster on screen and ready to copy,
and a short guide to paste into your agent's rules (AGENTS.md, CLAUDE.md or
a skill). **Copy as prompt** (`A` on a row, or the row menu) puts a prompt
about that object on the clipboard: its kind, name, cluster and what the
table says is wrong, never its logs or manifest.

`nauvi mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio. It offers the tools `problems`, `list`, `get`,
`describe`, `logs` (of a pod or of `deploy/`, `sts/`, `ds/`, `job/`,
`rs/`), `events` and `top`. It uses the CLI's kubeconfig and current context (or `--context`,
`--kubeconfig`, never the app's added kubeconfigs) and acts as that user,
so RBAC applies. It connects on the first tool call. A context set to
read-only or protected in the app refuses the write tools, even with
`--allow-writes`.

- **`problems(namespace?, kinds?, limit?)`** says what is wrong and why;
  start a health check here. It lists only the unhealthy pods, workloads,
  Jobs, Nodes and PersistentVolumeClaims, newest problem first, one line
  each, with the reason: the last termination (reason, exit code, age),
  the memory limit for an OOM kill, eviction, image-pull and scheduling
  messages, an old ReplicaSet left behind, condition messages. An `Error`
  with exit code 137 reads `likely OOM-killed`, with the memory limit (or
  `no memory limit`). Pods restarted in the last 24 hours are listed as
  "Restarted N times"; older restarts are in a separate "Restarted earlier,
  running fine since" section. It never reads Secrets.
- **`list`** gives pods a `LAST` column (`OOMKilled 27d`, `Error 2h`).
  `columns` picks columns and their order; `compact` drops NODE, and
  NAMESPACE when a namespace is given.
- **`events`** with nothing to show notes that the cluster keeps events for
  about an hour by default (`--event-ttl`), and points to `problems` and
  `describe`.
- **Read-only by default.** `--allow-writes` adds `scale`, `restart`,
  `delete` (one named object) and `apply` (server-side apply, with a
  `dry_run` option). Without the flag these tools are not offered, and a
  call to one is refused. Turn it on only for a context you would let the
  assistant change: `apply` can create a workload that reads Secrets, and
  `delete` of a Namespace or a CRD deletes everything in it.
- **Secret values are never returned**, only their keys; the
  `last-applied-configuration` annotation is hidden on every object.
  ConfigMaps, pod specs (including `env` values) and logs are shown as
  `kubectl` shows them.
- **Output is capped** at 1000 lines and 64 KiB per call: at most 500
  objects per list (100 by default), 1000 log lines per pod (100 by
  default) from at most 10 pods of a workload, and 200 events (50 by
  default). A manifest for `apply` can be at most 512 KiB.

Claude Code:

```sh
claude mcp add nauvi -- nauvi mcp
# a fixed context, with the write tools:
claude mcp add nauvi-staging -- nauvi --context staging mcp --allow-writes
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`)
and other clients take the same command (VS Code's `.vscode/mcp.json` puts
it under `"servers"`):

```json
{
  "mcpServers": {
    "nauvi": { "command": "nauvi", "args": ["mcp"] }
  }
}
```

Use the full path to `nauvi` if the client does not see your shell's
`PATH`. Desktop clients often start without your shell's environment: add
`"env": { "KUBECONFIG": "..." }` if your kubeconfig is not
`~/.kube/config`. Exec credential plugins (EKS, GKE, AKS) must log in
without a prompt, so sign in once in a terminal first.

### Ask AI

**Ask AI** opens your own AI coding CLI (Claude Code, Codex, Gemini CLI, or
a command of your own) in a dock terminal, pointed at the cluster, the
namespace or the object on screen, with `nauvi mcp` for the same context
offered to it for that session. Start it from the header's Ask AI button
(the cluster, or the one selected namespace), "Ask AI about this…" in the
detail panel (the object), or the palette ("Ask AI…", and "Ask AI about
this…" for the focused row). The dialog picks the CLI and prefills the
prompt with the scope; edit it, it is the CLI's first message.

- **What runs:** only a known CLI found on your `PATH`, or the command set
  in Settings → AI → Custom command (it gets the prompt in a file named by
  `NAUVI_PROMPT_FILE` and the MCP configuration in `NAUVI_MCP_CONFIG`).
  nauvi never downloads or installs a CLI; without one, the dialog lists
  what to install. Nothing goes through a shell string. The tab is a local
  terminal (same per-terminal kubeconfig as above); when the CLI exits,
  your shell starts in the same tab (on Windows the tab ends).
- **MCP for that session only:** the `nauvi` CLI on your `PATH` is passed
  to the AI CLI as an MCP server for this session, never written into the
  CLI's own configuration. It is read-only by default. **Allow writes**
  adds the write tools; it is offered only on a normal context, and the
  backend and `nauvi mcp` refuse writes on a protected or read-only one.
- **Read-only contexts** refuse Ask AI, like any terminal, and a context
  that turns read-only closes its Ask AI tabs. A protected context asks for
  its name before the terminal starts.
- **The CLI's own commands:** the read-only setting covers the nauvi tools
  only. Commands the CLI runs in its own shell (`kubectl`, `helm`…) are
  allowed or refused by the CLI's own approval prompts, not by nauvi.
- **What leaves your machine** is up to your CLI and its provider: nauvi
  sends nothing itself. The prompt holds only names, no cluster data.

## Install

There is no tagged release yet. The one-line installers and Homebrew below
work once v0.1.0 is published on the
[Releases page](https://github.com/nexburst/nauvi/releases); until then,
build from source (below).

The desktop app and the CLI are separate installs. The app is called
`nauvi-desktop` on Linux and the CLI `nauvi`, so both fit in the same
folder.

### Linux (Ubuntu, x86_64)

The desktop app:

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh
```

Only the CLI (`nauvi`):

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh -s -- --cli
```

The script downloads the latest release, checks each file against the
release's `SHA256SUMS` before installing it, and needs no sudo:

- The app: the AppImage as `~/.local/bin/nauvi-desktop`, a menu entry
  (`~/.local/share/applications/nauvi.desktop`) that also opens `nauvi://`
  links, and its icon. The app updates itself.
- The CLI: `~/.local/bin/nauvi`.
- The AppImage needs FUSE 2. If it is missing, the script prints the
  package to install and does not install it itself:
  `sudo apt install libfuse2t64` on Ubuntu 24.04 and later (Debian 13),
  `sudo apt install libfuse2` before.
- It warns when `~/.local/bin` is not on your `PATH`.

Run the same command again to upgrade. `--uninstall` removes the app, the
CLI, the menu entry and the icons, and keeps your settings:

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh -s -- --uninstall
```

`NAUVI_VERSION=v0.1.0` installs a given release instead of the latest, and
`NAUVI_INSTALL_DIR` (an absolute path) changes `~/.local/bin`. Put them
before `sh` (`curl … | NAUVI_VERSION=v0.1.0 sh`). Other architectures (arm64)
have no build yet.

To download by hand from the Releases page instead:

- `.deb`: `sudo apt install ./nauvi_*_amd64.deb`. It installs
  `/usr/bin/nauvi-desktop` and a menu entry.
- `.AppImage`: `chmod +x nauvi_*_amd64.AppImage` and run it.
- The CLI: `nauvi-cli-v<version>-x86_64-unknown-linux-gnu.tar.gz` holds the
  `nauvi` binary.

If the window stays blank (some GPU drivers), start the app with
`WEBKIT_DISABLE_DMABUF_RENDERER=1`. On a machine without a GPU (VMs, remote
desktops) nauvi turns WebKitGTK's DMA-BUF renderer off by itself, which saves
about 170 MB; set `WEBKIT_DISABLE_DMABUF_RENDERER=0` to keep it.

### macOS

The same script works on macOS (Apple silicon and Intel):

```sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh -s -- --cli
```

The first installs `nauvi.app` from the universal `.dmg` into
`/Applications` (or `~/Applications` when `/Applications` is not writable;
`NAUVI_APP_DIR` changes it). The second installs the CLI as
`~/.local/bin/nauvi`. `--uninstall` removes both; your settings are kept.

Or with Homebrew:

```sh
brew install --cask nexburst/tap/nauvi   # the desktop app
brew install nexburst/tap/nauvi-cli      # the CLI, with bash, zsh and fish completions
```

Homebrew 6 and later refuse to load packages from a tap you have not
trusted; run `brew trust nexburst/tap` first if it asks. The app updates
itself, so `brew upgrade` leaves it alone (`brew upgrade --cask --greedy
nauvi` updates it anyway). `brew uninstall --zap --cask nauvi` also removes
its settings and logs. The CLI formula works with Homebrew on Linux
(x86_64) too.

To download by hand: the universal `.dmg`, or the CLI as
`nauvi-cli-v<version>-aarch64-apple-darwin.tar.gz` (Apple silicon) or
`-x86_64-apple-darwin.tar.gz` (Intel). Open the `.dmg` and drag the app to
Applications in Finder. Don't run it from the disk image: macOS then runs it
from a temporary read-only copy, which can't update itself.

The app is not signed yet, so macOS blocks it the first time when it came
from a browser download or Homebrew. The first launch says "Apple could not verify…"; click Done,
then open System Settings → Privacy & Security and click **Open Anyway**
next to the nauvi message (on macOS 15 and later, right-click → Open no
longer offers this). If macOS says the app is damaged, run
`xattr -dr com.apple.quarantine /Applications/nauvi.app`. A `nauvi` CLI
binary downloaded with a browser is killed at launch (exit status 137)
until you remove the quarantine flag: `xattr -d com.apple.quarantine ./nauvi`.
The install script downloads with curl, which sets no quarantine flag, so
neither step should be needed after it.

### Windows (x64)

In PowerShell, the desktop app:

```powershell
irm https://raw.githubusercontent.com/nexburst/nauvi/main/install.ps1 | iex
```

Only the CLI:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/nexburst/nauvi/main/install.ps1))) -Cli
```

The script checks the download against `SHA256SUMS` like the Linux one. The
app comes from the `.msi` (`msiexec /passive`; Windows asks for permission)
and updates itself. The CLI goes to `%LOCALAPPDATA%\nauvi\bin\nauvi.exe`,
which is added to your user `PATH`; open a new terminal to use it. Run it
again to upgrade. `-Uninstall` (in the same scriptblock form as `-Cli`)
removes the CLI and its `PATH` entry, and the app too unless `-Cli` is
given; your settings are kept. `$env:NAUVI_CLI = '1'` before the `| iex`
form does the same as `-Cli`; `NAUVI_VERSION` and `NAUVI_INSTALL_DIR` work
as on Linux.

To download by hand: the `.msi`, the NSIS `-setup.exe`, or the CLI as
`nauvi-cli-v<version>-x86_64-pc-windows-msvc.zip`. The builds are not signed
yet, so SmartScreen may show "Windows protected your PC"; click More info,
then Run anyway.

### Checking a download

Every release has a `SHA256SUMS` file; check what you downloaded with
`sha256sum -c SHA256SUMS --ignore-missing`. It protects against a broken or
swapped download, not against a compromised release, since it comes from the
same place. Each release also ships CycloneDX SBOMs (`nauvi-<tag>-*.cdx.json`)
and is scanned for known vulnerabilities with Grype.

### Size and memory

Download sizes of the v0.1.0 dry run:

| Platform | Download | Size |
| --- | --- | ---: |
| Linux | AppImage | 88.7 MB |
| Linux | .deb | 15.6 MB |
| macOS (universal) | .dmg | 26.8 MB |
| Windows | NSIS installer (`-setup.exe`) | 8.8 MB |
| Windows | .msi | 13.2 MB |
| CLI | .tar.gz / .zip | 7.6–9.1 MB |

Idle memory on Linux (release build, 30 s idle on the Overview of a kind
cluster, no GPU):

| Measure | Memory |
| --- | ---: |
| App process (RSS) | 136 MB |
| App + WebKitWebProcess (RSS) | 335 MB |
| All processes (PSS) | 234 MB |

PSS splits the shared libraries between the processes, so it is the fairer
total. The numbers come from one CI run; macOS and Windows are not measured
yet. CI keeps them in check: the `idle-memory` QA scenario fails a release
build above 159 MB, 389 MB and 274 MB (today's numbers plus 15%).

Memory also stays flat while you use the app. A table keeps only its rows,
not a copy of every full object; memory freed when you leave a table goes
back to the system (on Linux), and a pod's log stream is bounded, so a
flood waits in the API server instead of piling up in the app. Growth over
the idle baseline on Linux (release build, private dirty memory, median of
5 reads, a Config Maps table of 5,016 rows):

| Step | App process | WebKitWebProcess |
| --- | ---: | ---: |
| Config Maps table open | +10 MB (was +84) | +16 MB (was +22) |
| Back on the Overview | +8 MB (was +87) | +14 MB (was +23) |
| The table again | +14 MB (was +139) | +18 MB (was +30) |
| Back on the Overview again | +11 MB (was +140) | +13 MB (was +30) |
| A 50,000-line log tab open | +2.5 MB | +39 MB |
| That tab closed | +0.5 MB | −11.5 MB |

The app process was 276 MB RSS after two visits to that table, and is
now 153 MB. The `growth-memory` QA scenario fails a release build whose
growth goes over its budgets (app process 25–30 MB per step). Work on
memory is tracked in [#353](https://github.com/nexburst/nauvi/issues/353).

### Proxies

The app and the CLI ignore `HTTPS_PROXY` (and `NO_PROXY`) from the
environment when they talk to a cluster, so a machine-wide proxy doesn't
break access to local or internal clusters. To reach a cluster through a
proxy, set `proxy-url` on that cluster in the kubeconfig, or set one in the
app.

**Proxy per cluster** (cluster Settings → Network): an `http://`,
`https://` or `socks5://` proxy for that cluster's requests, watches,
terminals and port-forwards. Use `http://user:password@host:port` for a proxy
that wants a login; SOCKS5 works without one. An `https://` proxy's
certificate is checked against the system's trust store, plus an optional CA
file (a PEM file, full path) set under the proxy URL; a kubeconfig's
`https://` `proxy-url` gets the system's trust store only. The cluster's
certificate-authority, insecure-skip-tls-verify and client certificate are
never used for the proxy. The matching-kubectl download (Local terminal) does not use the proxy's CA
file; add that CA to the system trust store instead. nauvi keeps the proxy
in `proxies.json` in its config folder (readable only by you), never in your
kubeconfig, and shows the password masked. It replaces the kubeconfig's
`proxy-url` for that cluster. A cluster on your machine (kind, minikube) is
reached directly unless you tick "Also for a cluster on this machine". It
applies the next time a window connects (Reconnect now).

`helm` and `kubectl` started from the app (Helm actions, the local terminal)
don't use these proxies; they use the environment as usual.

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
page. Drag nauvi into Applications with Finder to update it in place.

## Build and run from source

You need:

- Rust 1.95 or newer
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
`cargo run -p nauvi-desktop` on its own shows a connection error unless
`npm --prefix desktop/ui-src run dev` is running. `cd desktop && cargo tauri
build` builds the UI (`npm run build` in `desktop/ui-src`) and makes a release
build with it bundled; add `--no-bundle` to skip the installers. The
installers include signed update bundles, which need the release signing key
(`TAURI_SIGNING_PRIVATE_KEY`); without it, build them unsigned with
`cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.

Debug builds never check for updates. To try the update banner, serve a
`latest.json` with a higher `version` (for example with
`python3 -m http.server` in its folder) and start the app with
`NAUVI_UPDATE_ENDPOINT=http://127.0.0.1:8000/latest.json cargo tauri dev`;
release builds ignore this variable. Installing from it also needs bundles
signed with the release key.

## Test cluster

`bash scripts/test-cluster/setup.sh` creates a local test cluster with
[kind](https://kind.sigs.k8s.io/) (Kubernetes IN Docker): real nodes running
real containers, so logs, exec, port-forwarding and the CPU/memory columns
all work end to end. It needs Docker, usable by your user without `sudo`.
The script installs `kind` and `kubectl` into `~/.local/bin` if they are
missing.

It creates `nauvi-test` (a control-plane node and a worker) with:

- metrics-server (patched with `--kubelet-insecure-tls`, which kind's
  self-signed kubelet certs need), so the usage columns and `nauvi top`
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

Pass `--staging` to also create `nauvi-staging`, a single empty node, so
the context switcher has a second cluster to switch to. Each kind cluster
costs roughly 500 MB to 1 GB of RAM, which is why it is opt-in.

kind adds the contexts (`kind-nauvi-test`, `kind-nauvi-staging`) to
`~/.kube/config` and the script leaves `kind-nauvi-test` current.

Delete the clusters with `kind delete cluster --name nauvi-test` (and
`nauvi-staging`); re-run the script to recreate them.

## Contributing

[docs/ux-standard.md](docs/ux-standard.md) is the UX standard the app is
measured against: what Lens, k9s, Headlamp, Aptakube and others share, where
nauvi stands on each point, and the backlog that follows from it.

See [CLAUDE.md](CLAUDE.md) (also available as `AGENTS.md`) for the code
layout, the checks CI runs, how to regenerate the IPC bindings, and how to run
the unit, frontend and cluster tests.

## License

MIT
