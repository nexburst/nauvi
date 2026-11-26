# Clusters, windows and the catalog

nauvi reads the contexts of your kubeconfig files (`KUBECONFIG`, or
`~/.kube/config`) and any you add. It only reads them: it never changes your
kubeconfig.

## The cluster tree

The sidebar holds a tree of every kubeconfig context, grouped by file.
Nothing connects until you use it: expand a cluster to connect it in the
background and see its resource types, and click its name to show it.

- Several clusters stay connected in one window. Tables and the Overview
  watch only the one shown.
- Logs, terminals and port forwards keep running when you show another
  cluster. Dock tabs, port forwards, notifications and the status bar name
  the cluster each one runs on, in the cluster's colour.
- The colour also runs along the top edge of the window and shows in every
  confirm dialog. A read-only or protected cluster without a colour gets an
  amber or red edge.
- The other clusters this window is connected to are chips beside the
  context selector: click one to show it, **✕** to disconnect it. **✕** on a
  cluster's row in the tree does the same and stops what runs there.
- Long cloud context names (EKS ARNs, GKE, AKS) show the cluster name; hover
  for the full name.

## The status bar

The status bar shows the cluster, its Kubernetes version and the time. On a
live view it says `Live · last change <time>`: the rows are current, and the
time is when they last changed. `Stale since <time>` means the connection is
lost and the rows are as of that time.

## Background clusters

A cluster you are not looking at is disconnected after 10 minutes untouched
(**Settings → Background clusters**; Never turns this off). A port forward,
terminal, local shell, log stream or drain keeps it connected. So does a
[login command](login-commands.md) that may ask you something, unless the
kubeconfig sets `interactiveMode: Never` or the plugin is known not to ask
(aws eks get-token without a profile, aws-iam-authenticator,
gke-gcloud-auth-plugin, kubelogin with `--login`
spn/msi/workloadidentity/azurecli). Using the cluster again reconnects it,
without asking about its login command again.

## Hiding clusters

**Hide** a cluster with the eye button in the tree or the catalog's **⋯**
menu. It is only hidden in nauvi: your kubeconfig is never changed. The
catalog's **Show hidden** lists hidden clusters with an **Unhide** button.

## The cluster catalog

The grid button next to the context selector, or "Go to Cluster catalog" in
the palette, opens the catalog: every context with its API server, user,
source file, last use and status (connected, login failed, certificate
problem, unreachable, not allowed).

- Statuses are checked when the catalog opens, except for contexts that run a
  login command or send local files (below), which are checked only when you
  click **Check**.
- **Add** more kubeconfig files or a folder of them (watched for changes), or
  **paste** a kubeconfig (saved as `kubeconfigs/<name>.yaml`, mode 0600, in
  the app's config directory). Each added file connects on its own; a context
  whose name is already taken shows up as `name (file name)`. Removing an
  added file or folder leaves it as it is.
- **Pin** clusters to put them first in the context selector and the palette.
- Contexts of an added kubeconfig that send a token file or client
  certificate/key from outside that kubeconfig's folder are listed under
  "Sends local files" and checked only when you click **Check**.

## A cluster's Settings

Each cluster's Settings page has:

- its display name and colour;
- default and accessible namespaces;
- the Prometheus Service ([Metrics](metrics.md));
- the local terminal's working directory;
- a proxy (**Network**, see [Use a proxy](../../how-to/proxy.md));
- a read-only or protected mode (**Changes**, see [modes](modes.md));
- **Hide metrics** (**Metrics**).

## Windows

Open a context in its own window with the button next to the context
selector, or "Open context in new window…" in the palette. Each window has
its own clusters, watches, logs, terminals and port forwards, and closing one
leaves the others alone.

- The windows open when you quit are reopened on the next start, where they
  were and at their size. "New window" opens offset from the current window.
- On macOS, closing the last window keeps nauvi in the Dock (that window's
  port forwards, shells and logs stop with it); click the Dock icon to open a
  window again.
- nauvi runs once per user: launching it again (from the menu, a shortcut or
  the command line) brings the running app's window to the front instead of
  starting a second copy. On Linux this uses the D-Bus session bus; without
  one, each launch starts its own copy.
