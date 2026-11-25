<!-- Generated from src/args.rs by src/cli_docs.rs. Do not edit: run
     NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference -->

# Helm

Read Helm releases straight from the cluster. No `helm` binary is needed.

Every command also takes the [global options](index.md#global-options) (`--context`, `--kubeconfig`).

## `nauvi helm`

Helm releases, read from the cluster (no helm binary needed)

```text
nauvi helm <COMMAND>
```

### `nauvi helm list`

List releases with their chart, revision and status.

```text
nauvi helm list [OPTIONS]
```

| Argument | What it does |
| --- | --- |
| `-n, --namespace <NAMESPACE>` | Only this namespace (default: all namespaces) |

### `nauvi helm get`

Show one release: its status, values, manifest, notes or history.

```text
nauvi helm get [OPTIONS] <RELEASE> [<SECTION>]
```

| Argument | What it does |
| --- | --- |
| `<RELEASE>` | The release's name |
| `<SECTION>` | One of `all`, `values`, `manifest`, `notes`, `history`. Default: `all` |
| `-n, --namespace <NAMESPACE>` | Namespace (default: the context's namespace) |
| `--revision <REVISION>` | Revision to show (default: the newest) |
| `--all` | Values: include the chart defaults |
| `--reveal` | Manifest: show Secret values instead of a placeholder |
