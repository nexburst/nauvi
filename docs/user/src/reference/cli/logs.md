<!-- Generated from src/args.rs by src/cli_docs.rs. Do not edit: run
     NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference -->

# Logs

Read or follow the logs of one pod, or of every pod of a workload.

Every command also takes the [global options](index.md#global-options) (`--context`, `--kubeconfig`).

## `nauvi logs`

Show the last lines of a pod's logs, or of every pod of a workload.

```text
nauvi logs [OPTIONS] <NAME>
```

| Argument | What it does |
| --- | --- |
| `<NAME>` | Pod name, or `deploy/<name>`, `sts/<name>`, `ds/<name>`, `job/<name>` to merge the logs of all its pods (`[pod] line`) |
| `-n, --namespace <NAMESPACE>` | Pod namespace |
| `--tail <TAIL>` | Number of lines from the end of the logs. Default: `200` |
| `-c, --container <CONTAINER>` | Container name (including init containers); default container if omitted |
| `-p, --previous` | Show the logs of the previous (crashed) container instance |
| `-f, --follow` | Stream new log lines until interrupted |
