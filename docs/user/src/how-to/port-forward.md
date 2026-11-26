# Forward a port to a Service

This page connects a port on your machine to a Service in the cluster, so a
browser or a database client on your machine can reach it.

## In the app

1. Open **Network → Services** (press `G`, type `svc`, Enter) and find the
   Service.
2. Right-click its row (or click **⋮**) and choose **Port forward…**, or use
   the button in its detail panel.
3. Pick the Service port. Leave the local port empty to get a free one, or
   type the one you want.
4. Tick **https** if the target speaks TLS (the URL becomes `https://`), and
   **Open in browser** to open the URL whenever the forward starts.
5. Tick **Start automatically** to start it each time you open this cluster.

After the forward starts, a banner offers **Open** (the URL) and **Port
Forwards** (the list).

A Service forward picks a ready pod for each new connection, so it keeps
working when pods restart or a rollout replaces them. Idle connections (a
database client between queries) stay open.

### Manage forwards

**Network → Port Forwards** lists every forward of the cluster with its
current pod and status; start, stop, edit and delete them there. Forwards
are saved per cluster:

- they keep running when you close panels or show another cluster;
- they stop when you disconnect that cluster or close the window;
- they come back stopped, or running if you ticked *Start automatically*.

A saved forward runs in one window at a time. Other windows on that context
show "Running in another window" and can't start it until it is stopped
there.

The same works for pods and workloads (Deployments, StatefulSets,
DaemonSets, ReplicaSets): **Port forward…** in their row menu or panel.

## With the CLI

```sh
nauvi port-forward svc/web 8080:80 -n demo
```

The forward runs until Ctrl-C. Ports can be `8080:80` (local 8080 to remote
80), `:80` (a random local port) or `80` (the same local port if it is free
and at least 1024, else a random one). The remote port may be a port name.
The target can be a pod name, `svc/<name>`, `deploy/<name>`, `sts/`, `rs/`,
`ds/` or `pod/`. See [`nauvi port-forward`](../reference/cli/shells.md#nauvi-port-forward).

## Why it is fast

A forward keeps one connection to each pod it forwards to and opens a stream
on it per local connection, as `kubectl` does; nothing connects to the pod
until a client does. New connections reuse a warm connection to the API
server. On kind, a new connection takes about 16 ms through a pod forward and
19 ms through a Service forward (median). `NAUVI_PORT_FORWARD_MULTIPLEX=0`
falls back to one API-server upgrade per connection.
