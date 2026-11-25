# MCP tools

`nauvi mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio. [Use nauvi from an AI assistant](../how-to/mcp.md) sets it
up; [`nauvi mcp`](cli/mcp.md) lists its options.

It uses the CLI's kubeconfig and current context (or `--context`,
`--kubeconfig`, never the app's added kubeconfigs) and acts as that user, so
RBAC applies. It connects on the first tool call. A context set to read-only
or protected in the app refuses the write tools, even with `--allow-writes`.

## Read tools

| Tool | What it returns |
| --- | --- |
| `problems(namespace?, kinds?, limit?)` | What is wrong and why; start a health check here |
| `list` | Objects of a kind, as a table |
| `get` | One object |
| `describe` | One object like `kubectl describe` |
| `logs` | Logs of a pod, or of `deploy/`, `sts/`, `ds/`, `job/`, `rs/` |
| `events` | Events |
| `top` | CPU and memory usage |

- **`problems`** lists only the unhealthy pods, workloads, Jobs, Nodes and
  PersistentVolumeClaims, newest problem first, one line each, with the
  reason: the last termination (reason, exit code, age), the memory limit for
  an OOM kill, eviction, image-pull and scheduling messages, an old
  ReplicaSet left behind, condition messages. An `Error` with exit code 137
  reads `likely OOM-killed`, with the memory limit (or `no memory limit`).
  Pods restarted in the last 24 hours are listed as "Restarted N times";
  older restarts are in a separate "Restarted earlier, running fine since"
  section. It never reads Secrets.
- **`list`** gives pods a `LAST` column (`OOMKilled 27d`, `Error 2h`).
  `columns` picks columns and their order; `compact` drops NODE, and
  NAMESPACE when a namespace is given.
- **`events`** with nothing to show notes that the cluster keeps events for
  about an hour by default (`--event-ttl`), and points to `problems` and
  `describe`.

## Write tools

Offered only with `--allow-writes`; without the flag they are not offered,
and a call to one is refused.

| Tool | What it does |
| --- | --- |
| `scale` | Set a workload's replica count |
| `restart` | Rollout restart |
| `delete` | Delete one named object |
| `apply` | Server-side apply, with a `dry_run` option |

Turn writes on only for a context you would let the assistant change:
`apply` can create a workload that reads Secrets, and `delete` of a Namespace
or a CRD deletes everything in it.

## What is hidden

- **Secret values are never returned**, only their keys.
- The `last-applied-configuration` annotation is hidden on every object.
- ConfigMaps, pod specs (including `env` values) and logs are shown as
  `kubectl` shows them.

## Limits

Output is capped at 1000 lines and 64 KiB per call:

- at most 500 objects per list (100 by default);
- 1000 log lines per pod (100 by default) from at most 10 pods of a workload;
- 200 events (50 by default).

A manifest for `apply` can be at most 512 KiB.
