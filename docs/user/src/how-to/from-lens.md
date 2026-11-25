# Move from Lens

nauvi covers the same daily work as Lens and is built to stay fast. This page
maps what you know from Lens to where it is in nauvi.

| In Lens | In nauvi |
| --- | --- |
| The catalog of clusters | The **Cluster catalog** (grid button next to the context selector); the drawer's tree for connecting several at once |
| The sidebar of resource kinds | The **drawer** (`G`), or keep it open as a column with **Keep open**; **berths** at the left edge for the kinds you use most |
| Hotbar | Berths: up to nine places, keys `1`–`9` |
| Adding a kubeconfig | Catalog → add a file, a folder (watched), or paste one |
| Workloads overview | **Workloads → Overview** |
| Pod logs, shell | `L` and `S` on the row, or the panel's header; both open in the **dock** |
| Port forwarding | **Port forward…** on a pod, Service or workload; **Network → Port Forwards** for saved ones |
| Edit resource | `E` on the row: YAML with server-side apply |
| Helm releases and charts | **Helm** in the drawer: releases, charts, repositories |
| Extensions | Not supported. Ask AI and `nauvi mcp` connect your own AI tools |
| Metrics (Prometheus) | Found automatically, or set per cluster in Settings; metrics-server is enough for usage columns |
| Lens account | None. nauvi needs no account and sends no telemetry |

What is different:

- **Watches, not polling.** Tables update from Kubernetes watches and stay
  smooth with thousands of rows. See
  [How nauvi talks to your cluster](../explanations/cluster-access.md).
- **Keyboard first.** `Ctrl+K` / `Cmd+K` jumps to any kind, namespace,
  context or object. k9s-style keys work on the focused row. See
  [Keyboard shortcuts](../reference/app/keyboard.md).
- **Safety per cluster.** Mark a cluster read-only or protected; the backend
  enforces it ([modes](../reference/app/modes.md)).
- **Your kubeconfig is never changed.** Hiding a cluster, adding files and
  terminals all leave your files alone.
- **A CLI on the same core.** `nauvi get`, `logs`, `exec`, `port-forward`,
  `drain`, with the same columns as the app.
