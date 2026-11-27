# How nauvi talks to your cluster

This page explains what nauvi does on the network, so you can predict its
load on the API server and its behaviour when the connection is poor.

## Your kubeconfig, your user

nauvi connects as the user of the kubeconfig context, exactly as `kubectl`
would: same server, same certificates, same login command. Everything it
shows or changes is subject to that user's RBAC. It reads your kubeconfig
files and never writes them.

## Watches, not polling

Tables and the Overview are filled by a **list** and then kept current by a
Kubernetes **watch**: the API server pushes each change as it happens. That
is why rows change the moment a pod does, and why an idle table costs almost
nothing. A table keeps only its rows, not a copy of every full object.

- Only the cluster on screen is watched. Other connected clusters keep their
  logs, terminals and port forwards, but no table watches.
- Several namespaces are one watch each, up to 10.
- The Overview is kept live by watches too, not by re-listing the cluster.
- The status bar says `Live · last change <time>` while the rows are current,
  and `Stale since <time>` when the connection is lost.

Metrics are the exception: metrics-server has no watch, so usage is polled
while a view that shows it is open (or never, with **Hide metrics**).

Image security reports are not watched either. While image security is on,
they are listed when a view that shows them opens, and that listing is
reused for a day by default ([Image security](../how-to/image-security.md#what-nauvi-reads-and-when)).

## Connecting on demand

Nothing connects until you use it. Expanding a cluster in the tree connects
it in the background. A cluster you are not looking at is disconnected after
10 minutes untouched, unless something still runs on it
([Background clusters](../reference/app/clusters.md#background-clusters)).

## When the cluster does not answer

A watch whose API server stops answering is noticed within about 23 seconds.
The view shows Reconnecting and retries, first every second, then up to
every ten. A view that cannot start at all is retried after 5, 10, 20 and
40 seconds, then every minute. Both stop after about five minutes and say so;
Refresh starts over ([details](../reference/app/diagnostics.md#when-a-cluster-does-not-answer)).

Logs, terminals and port forwards keep their own connections and are not
part of this.

## Proxies

The app and the CLI ignore `HTTPS_PROXY` from the environment for cluster
traffic and use only a proxy set for that cluster, in the kubeconfig or in
the app ([Use a proxy](../how-to/proxy.md)).

## What else goes on the network

- The **update check**: at start and about every 12 hours, to GitHub's
  release endpoint (turn it off in Settings). Nothing is downloaded until
  you click Install.
- **Available tags**, only if you turned it on and clicked: the image's
  registry, over HTTPS ([Find a newer tag](../how-to/image-tags.md)).
- The **matching kubectl** download from dl.k8s.io, only if you turned it on
  and clicked.
- **Helm**: chart repositories you added, and the pinned metrics-server and
  Prometheus charts if you install them.

The app window itself loads nothing from the network: a strict Content
Security Policy allows only the app's own files and its IPC. nauvi has no
telemetry.
