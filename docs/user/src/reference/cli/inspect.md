<!-- Generated from src/args.rs by src/cli_docs.rs. Do not edit: run
     NAUVI_WRITE_CLI_DOCS=1 cargo test --bin nauvi cli_reference -->

# Look at resources

Commands that read the cluster and print what is there. None of them change anything.

Every command also takes the [global options](index.md#global-options) (`--context`, `--kubeconfig`).

## `nauvi problems`

Only what is wrong, and why: crash-looping, failed, not ready or pending pods, recent restarts, workloads short of replicas, failed Jobs, not-ready Nodes, lost PVCs (the same findings as the MCP `problems` tool)

```text
nauvi problems [OPTIONS]
```

| Argument | What it does |
| --- | --- |
| `-n, --namespace <NAMESPACE>` | Only this namespace (default: all namespaces) |
| `-A, --all-namespaces` | All namespaces (the default; accepted for kubectl habits) |
| `-k, --kind <KIND>` | Only these kinds (pods, deployments, statefulsets, daemonsets, replicasets, jobs, nodes, persistentvolumeclaims); repeat or separate with commas |
| `--limit <LIMIT>` | At most this many rows. Default: `50` |

## `nauvi get`

List or show any resource type, including CRDs (like kubectl get)

```text
nauvi get [OPTIONS] <KIND> [<NAME>]
```

| Argument | What it does |
| --- | --- |
| `<KIND>` | Resource type: plural, kind or short name (deploy, svc, widgets.example.com), or `<kind>/<name>` for one object |
| `<NAME>` | Show only this object |
| `-n, --namespace <NAMESPACE>` | Only list this namespace (default: all namespaces; for one named object, the context's namespace) |
| `-A, --all-namespaces` | List all namespaces (the default; accepted for kubectl habits) |
| `-o, --output <OUTPUT>` | Output format. One of `table`, `wide`, `yaml`, `json`, `name`. Default: `table` |
| `-l, --selector <SELECTOR>` | Label selector, e.g. `app=web,tier!=db` |
| `--field-selector <FIELD_SELECTOR>` | Field selector, e.g. `status.phase=Running` |
| `--reveal` | Show Secret values in yaml and json output |

## `nauvi describe`

Show one object of any kind like kubectl describe: metadata, owners, labels, conditions and events.

```text
nauvi describe [OPTIONS] <TARGET> [<NAME>]
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | `<kind>/<name>`, or the kind followed by the name |
| `<NAME>` | The object's name, when the kind is given on its own |
| `-n, --namespace <NAMESPACE>` | Namespace (default: the context's namespace) |

## `nauvi yaml`

Print an object of any kind as YAML (Secret values hidden)

```text
nauvi yaml [OPTIONS] <TARGET>
```

| Argument | What it does |
| --- | --- |
| `<TARGET>` | `<kind>/<name>` (`deploy/web`), or a pod name |
| `-n, --namespace <NAMESPACE>` | Namespace (default: the context's namespace) |
| `--reveal` | Show Secret values instead of a placeholder |

## `nauvi pods`

List pods (all namespaces by default)

```text
nauvi pods [OPTIONS]
```

| Argument | What it does |
| --- | --- |
| `-n, --namespace <NAMESPACE>` | Only list pods in this namespace |

## `nauvi namespaces`

List namespaces.

```text
nauvi namespaces
```

## `nauvi nodes`

List nodes.

```text
nauvi nodes
```

## `nauvi watch`

Stream live changes to any resource type (until Ctrl-C)

```text
nauvi watch [OPTIONS] [<RESOURCE>]
```

| Argument | What it does |
| --- | --- |
| `<RESOURCE>` | What to watch: pods, nodes, deployments, a CRD, .... Default: `pods` |
| `-n, --namespace <NAMESPACE>` | Only watch this namespace |

## `nauvi tags`

Show the newer tags of an image in its registry: newer patch, minor and major versions with the same variant (`7.0.1-jammy` -> `7.0.2-jammy`). Reads the registry over HTTPS, anonymously or with your docker credentials (`docker login`); it does not use the cluster.

```text
nauvi tags [OPTIONS] <IMAGE>
```

| Argument | What it does |
| --- | --- |
| `<IMAGE>` | The image, e.g. `mongo:7.0.1` or `ghcr.io/org/app:v1.2.3` |
| `--image-id <ID>` | The `imageID` a pod reports for it (`docker.io/library/mongo@sha256:…`): says whether the tag was pushed again since |
| `--json` | Print JSON instead of text |

## `nauvi top`

Show CPU/memory usage (like kubectl top)

```text
nauvi top [OPTIONS] [<RESOURCE>]
```

| Argument | What it does |
| --- | --- |
| `<RESOURCE>` | What to show: pods or nodes. Default: `pods` |
| `-n, --namespace <NAMESPACE>` | Only show pods in this namespace |
