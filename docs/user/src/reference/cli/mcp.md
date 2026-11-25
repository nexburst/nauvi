<!-- Generated from src/args.rs by src/cli_docs.rs. Do not edit: run
     NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference -->

# nauvi mcp

The MCP server for AI assistants. See [Use nauvi from an AI assistant](../../how-to/mcp.md) for how to set it up.

Every command also takes the [global options](index.md#global-options) (`--context`, `--kubeconfig`).

## `nauvi mcp`

Serve the Model Context Protocol on stdio for AI assistants (read-only unless --allow-writes)

```text
nauvi mcp [OPTIONS]
```

| Argument | What it does |
| --- | --- |
| `--allow-writes` | Also offer the tools that change the cluster: scale, restart, delete and apply (RBAC still applies). `apply` can create workloads that read Secrets; `delete` of a Namespace or CRD deletes everything under it |
