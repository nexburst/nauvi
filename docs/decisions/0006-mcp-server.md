# 0006: The MCP server is read-only by default, redacts Secrets, caps output

**Status:** accepted (2026-11-16). Issue #298. Ask AI no longer passes it to a CLI: see [0010](0010-ask-ai-skill.md).

## Decision
`nauvi mcp` serves the Model Context Protocol on stdio, in the CLI only
(not in the desktop app, which builds the core without the `mcp` feature).

- **Protocol:** the official Rust SDK, `rmcp` (Apache-2.0, maintained by the
  MCP project, passes `cargo deny`), with only the `server` and
  `transport-io` features. Only `src/mcp/server.rs` uses it; the tools are
  plain functions returning text, so a change of SDK touches one file.
- **Read-only by default:** list, get, describe, logs, events, top. The write
  tools (scale, restart, delete, apply) are neither listed nor callable
  without `--allow-writes`. Every call runs as the kubeconfig's user, so
  RBAC decides the rest. `--allow-writes` is a real grant: `apply` can create
  workloads that read Secrets (and so reach their values through logs), and
  `delete` of a Namespace or CRD deletes everything under it.
- **Never returned:** Secret values (keys and sizes only; there is no
  `reveal`, since the server cannot ask the person) and the
  `last-applied-configuration` annotation of any kind. ConfigMaps, pod specs
  (including literal env values) and logs are returned as `kubectl` shows
  them.
- **Bounded:** at most 1000 lines and 64 KiB per result, 500 objects per
  list, 1000 log lines per pod and 10 pods per workload; logs keep their
  newest lines.
- **Credentials:** the CLI's kubeconfig (`--kubeconfig`, `KUBECONFIG`,
  `~/.kube/config`) and context, never the app's added sources. Exec plugins
  run non-interactively (stdin carries the protocol). The client is made on
  the first tool call, so a client can start the server without a cluster.
- **Untrusted data:** the server's instructions tell the model that results
  contain cluster data written by others (annotations, logs, events) to be
  treated as data, never as instructions.

## Consequences
A model can read what the user can read, minus Secret values. Anything else
sensitive in plain objects (env literals, ConfigMaps, log lines) is the
user's to keep out, as with `kubectl`.
