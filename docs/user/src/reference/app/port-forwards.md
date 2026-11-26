# Port forwards

A port forward connects a local port to a pod, a Service or a workload.
[Forward a port to a Service](../../how-to/port-forward.md) walks through one.

## Starting one

**Port forward…** in the row menu or the detail panel of a pod, Service,
Deployment, StatefulSet, DaemonSet or ReplicaSet. Choose the remote port and
a local port. Leave the local port empty to let nauvi pick one: the same
port when it is free and 1024 or more.

- **https**: for targets that speak TLS; the URL becomes `https://`.
- **Open in browser when it starts**: opens the URL whenever the forward
  starts. It is on by default for ports that look like a web server (80,
  443, 3000, 8080…, or a port named `http`, `https`, `web`), and then
  follows your last choice.
- **Start automatically**: starts it when the cluster opens.

After a forward starts, a banner offers **Open** and **Port Forwards**.

## How it behaves

- A Service forward picks a ready pod for each connection, so it keeps
  working when pods restart. Workload forwards do the same.
- Forwards are **saved per cluster**. Each keeps running until you stop it,
  disconnect its cluster, close its window or quit nauvi. Closing a panel or
  a dock tab, leaving the view or showing another cluster does not stop it.
- A stopped forward stays saved. It comes back stopped next time, or
  running if you ticked *Start automatically*.
- A saved forward runs in **one window at a time**. Other windows on that
  context show "Running in another window" and can't start it until it is
  stopped there.
- Idle connections (a database client between queries) stay open.
- On a [protected cluster](modes.md), starting a forward asks for the
  context's name. Forwards work on read-only clusters.

## Network → Port Forwards

Lists the cluster's forwards with their current pod and status, and starts,
stops, edits and deletes them.

## Speed

A forward keeps one connection to each pod it forwards to and opens a stream
on it per local connection, as `kubectl` does. Nothing connects to the pod
until a client does. New connections reuse a warm connection to the API
server and skip TCP's delayed ACK. On kind, a new connection takes about
16 ms through a pod forward and 19 ms through a Service forward (median; it
was about 57 and 60 ms before, and `kubectl port-forward` takes about 5 ms in
the same run). On a remote cluster that saves about two round trips per new
connection.

`NAUVI_PORT_FORWARD_MULTIPLEX=0` falls back to one API-server upgrade per
connection.
