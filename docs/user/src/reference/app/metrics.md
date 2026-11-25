# Metrics and Prometheus

nauvi shows CPU and memory usage from the cluster's metrics API
(metrics-server), and longer history from Prometheus when the cluster has
one.

## With metrics-server

- **Pods** and **Nodes** tables get CPU and memory columns, with a small
  trend line of the last 30 minutes.
- The **pod and node detail panels** chart CPU and memory (pods per container
  too) against requests and limits, or against allocatable for a node.
- The detail panels of Deployments, StatefulSets, DaemonSets, ReplicaSets and
  Jobs chart the summed CPU and memory of their pods against their summed
  requests and limits.

metrics-server keeps no history, so the trend starts when a view that shows
metrics opens.

## With Prometheus

When the cluster has a Prometheus, the charts show the last **1h, 6h or 24h**
from it. nauvi finds it by its usual Service names or the
`app.kubernetes.io/name=prometheus` label, or you set it per context in the
cluster's Settings (**Prometheus Service**).

nauvi queries it through the API server's service proxy, so you need `get`
on `services/proxy` in Prometheus's namespace. Without it, or without a
Prometheus, the charts say why and show the metrics-server history.

With Prometheus and node-exporter, the Nodes table gets a **Disk** column.

## Installing metrics-server or Prometheus

- The Overview offers to install **metrics-server** (in `kube-system`) when
  it is missing. **Skip kubelet TLS verification** makes metrics-server trust
  any kubelet certificate: it is meant for kind and other local clusters with
  self-signed kubelet certificates, so leave it off elsewhere.
- **Settings → Prometheus** offers to install a small **Prometheus** stack
  (Prometheus, kube-state-metrics and node-exporter, in `monitoring`, with no
  persistent volume by default). node-exporter runs as a DaemonSet on every
  node.

Both installs run the `helm` CLI with a chart pinned to an exact version from
each chart's upstream repository (kubernetes-sigs/metrics-server,
prometheus-community). The chart repository is never added to your helm
repositories. You can edit the values; a dry run runs first, and nothing
changes until you confirm. They create ClusterRoles and ClusterRoleBindings,
and metrics-server also an APIService, so you need permission to create
those.

## Hide metrics

**Hide metrics** (the cluster's **Settings → Metrics**) hides CPU and memory
usage for that cluster (table columns, charts, the Overview's usage) and
stops polling its metrics API. A note with a link to the setting shows where
the metrics would be.
