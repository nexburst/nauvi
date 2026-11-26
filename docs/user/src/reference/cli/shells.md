<!-- Generated from src/args.rs by src/cli_docs.rs. Do not edit: run
     NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference -->

# Shells, debugging and port forwards

Commands that run something in a pod or on a node, or connect a local port to the cluster.

Every command also takes the [global options](index.md#global-options) (`--context`, `--kubeconfig`).

## `nauvi exec`

Run a command in a pod (non-interactive)

Exits with the command's exit code, like `kubectl exec`: 0 when it succeeds, its own code when it exits non-zero, and 1 when it cannot be run (no such pod, container or executable).

```text
nauvi exec [OPTIONS] <NAME> -- <COMMAND>...
```

| Argument | What it does |
| --- | --- |
| `<NAME>` | Pod name |
| `-n, --namespace <NAMESPACE>` | Pod namespace |
| `-c, --container <CONTAINER>` | Container name (defaults to the pod's only container) |
| `<COMMAND>` | Command to run (after --) |

## `nauvi attach`

Attach to the main process of a pod's container (its stdin and output), like `kubectl attach -it`. The container must have been started with `stdin: true`; detaching (Ctrl-C without a TTY, or closing the terminal) leaves the process running.

```text
nauvi attach [OPTIONS] <POD>
```

| Argument | What it does |
| --- | --- |
| `<POD>` | Pod name |
| `-n, --namespace <NAMESPACE>` | Pod namespace (default: `default`) |
| `-c, --container <CONTAINER>` | Container (default: the pod's default container, else its first) |

## `nauvi debug`

Open a shell in a pod through an ephemeral debug container that shares a container's processes. Works on images without a shell; the container cannot be removed and stays until the pod is deleted.

```text
nauvi debug [OPTIONS] <POD>
```

| Argument | What it does |
| --- | --- |
| `<POD>` | Pod name |
| `-n, --namespace <NAMESPACE>` | Pod namespace (default: `default`) |
| `-c, --container <CONTAINER>` | Container whose processes the debug container sees (default: the pod's first container) |
| `--image <IMAGE>` | Image of the debug container, e.g. `nicolaka/netshoot` for network tools. Default: `busybox:1.37` |

## `nauvi node-shell`

Open a root shell on a node through a privileged pod (deleted when the shell exits)

```text
nauvi node-shell [OPTIONS] <NODE>
```

| Argument | What it does |
| --- | --- |
| `<NODE>` | The node's name |
| `-n, --namespace <NAMESPACE>` | Namespace of the privileged pod; it must allow privileged pods. Default: `kube-system` |
| `--image <IMAGE>` | Image of the pod; it needs `nsenter`. Default: `busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec` |

## `nauvi port-forward`

Forward ports of a pod, Service or workload to localhost (until Ctrl-C). A Service or workload forward picks a ready pod for each connection, so it keeps working when pods restart.

```text
nauvi port-forward [OPTIONS] <TARGET> <PORT>...
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | A pod name, `pod/<name>`, `svc/<name>`, or `deploy/`, `sts/`, `rs/`, `ds/<name>` |
| `<PORT>` | `<remote>`, `<local>:<remote>` or `:<remote>` (random local port). The remote port may be a port name. With only `<remote>` the local port is the same if it is free and at least 1024, otherwise random |
| `-n, --namespace <NAMESPACE>` | Namespace (default: the context's namespace) |
