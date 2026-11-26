# Work with several clusters

This page shows how to keep several clusters connected in one window, tell
them apart, and open more windows.

## Connect more than one cluster

Press `G` (or click the compass at the foot of the berths) to open the
drawer. Its tree lists every context of your kubeconfig files, grouped by
file. Nothing connects until you use it:

- **expand** a cluster to connect it in the background and see its resource
  types;
- **click its name** to show it.

Several clusters stay connected in one window. Tables and the Overview watch
only the one shown. Logs, terminals and port forwards keep running when you
show another cluster.

The other clusters this window is connected to are chips next to the context
selector: click one to show it, **✕** to disconnect it. **✕** on a cluster's
row in the tree does the same and stops what runs there.

## Tell them apart

Give each cluster a display name and a **colour** in its Settings page. The
colour runs along the top edge of the window and shows in every confirm
dialog, dock tab, port forward, notification and the status bar, so you can
see at a glance where a command will run. A read-only or protected cluster
without a colour gets an amber or red edge.

Long cloud context names (EKS ARNs, GKE, AKS) show only the cluster name;
hover for the full name. **Pin** clusters in the catalog to put them first in
the context selector and the palette.

## Add kubeconfig files

The **Cluster catalog** (the grid button next to the context selector) adds
more kubeconfig files, a folder of them (watched for changes), or a pasted
kubeconfig. Each added file connects on its own. nauvi only reads these
files; removing one from nauvi leaves the file as it is.
[Clusters, windows and the catalog](../reference/app/clusters.md) has the
details.

## Open another window

The button next to the context selector, or "Open context in new window…" in
the palette (`win `), opens a context in its own window. Each window has its
own clusters, watches, logs, terminals and port forwards, and closing one
leaves the others alone. The windows open when you quit come back on the next
start, where they were and at their size.

## Protect production

In a cluster's **Settings → Changes**, set it to **Protected** (type the
context's name before every change) or **Read-only** (refuse every change).
See [Read-only and protected clusters](../reference/app/modes.md).

## Background clusters

A cluster you are not looking at is disconnected after 10 minutes untouched;
**Settings → Background clusters** changes that (Never turns it off). Using
it again reconnects it. A port forward, terminal, local shell, log stream or
drain keeps it connected, and so does a login command that may ask you
something.
