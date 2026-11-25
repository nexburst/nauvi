<!-- Generated from src/args.rs by src/cli_docs.rs. Do not edit: run
     NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference -->

# Actions

Commands that change the cluster. Errors say plainly what blocked them: not allowed, already gone, refused by a PodDisruptionBudget.

Every command also takes the [global options](index.md#global-options) (`--context`, `--kubeconfig`).

## `nauvi scale`

Set the replica count of a Deployment, StatefulSet or ReplicaSet.

```text
nauvi scale [OPTIONS] <TARGET>
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | `<kind>/<name>`, e.g. `deploy/web` |
| `--replicas <REPLICAS>` | The new number of replicas. Required |
| `-n, --namespace <NAMESPACE>` | Namespace (default: `default`) |

## `nauvi restart`

Restart the pods of a Deployment, StatefulSet or DaemonSet.

```text
nauvi restart [OPTIONS] <TARGET>
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | `<kind>/<name>`, e.g. `deploy/web` |
| `-n, --namespace <NAMESPACE>` | Namespace (default: `default`) |

## `nauvi cordon`

Mark a node unschedulable.

```text
nauvi cordon <NODE>
```

| Argument | What it does |
| --- | --- |
| `<NODE>` | The node's name |

## `nauvi uncordon`

Mark a node schedulable again.

```text
nauvi uncordon <NODE>
```

| Argument | What it does |
| --- | --- |
| `<NODE>` | The node's name |

## `nauvi drain`

Cordon a node and evict its pods (respects PodDisruptionBudgets)

```text
nauvi drain [OPTIONS] <NODE>
```

| Argument | What it does |
| --- | --- |
| `<NODE>` | The node's name |
| `--timeout <TIMEOUT>` | Give up after this many seconds. Default: `300` |
| `--pod-selector <POD_SELECTOR>` | Only evict pods matching this label selector |

## `nauvi evict`

Evict a pod through the Eviction API (respects PodDisruptionBudgets)

```text
nauvi evict [OPTIONS] <POD>
```

| Argument | What it does |
| --- | --- |
| `<POD>` | The pod's name, or `pod/<name>` |
| `-n, --namespace <NAMESPACE>` | Namespace (default: `default`) |

## `nauvi trigger`

Create a Job from a CronJob now.

```text
nauvi trigger [OPTIONS] <TARGET>
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | `cronjob/<name>` |
| `-n, --namespace <NAMESPACE>` | Namespace (default: `default`) |

## `nauvi suspend`

Suspend a CronJob.

```text
nauvi suspend [OPTIONS] <TARGET>
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | `cronjob/<name>` |
| `-n, --namespace <NAMESPACE>` | Namespace (default: `default`) |

## `nauvi resume`

Resume a suspended CronJob.

```text
nauvi resume [OPTIONS] <TARGET>
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | `cronjob/<name>` |
| `-n, --namespace <NAMESPACE>` | Namespace (default: `default`) |

## `nauvi delete`

Delete an object of any kind.

```text
nauvi delete [OPTIONS] <TARGET>
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | `<kind>/<name>` |
| `-n, --namespace <NAMESPACE>` | Namespace (default: `default`) |
| `--force` | Grace period 0, for pods stuck terminating (pods only) |

## `nauvi apply`

Create or update objects from a YAML file (like kubectl apply -f)

```text
nauvi apply [OPTIONS]
```

| Argument | What it does |
| --- | --- |
| `-f, --file <FILE>` | Manifest file, or `-` for stdin; may hold many documents. Required |
| `-n, --namespace <NAMESPACE>` | Namespace for objects that have none (default: the context's) |
| `--dry-run` | Validate on the server only; store nothing |
