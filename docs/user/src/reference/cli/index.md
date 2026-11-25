# Using the CLI

The `nauvi` CLI works on the same core as the app. Install it with
`install.sh --cli`, Homebrew's `nauvi-cli` or `install.ps1 -Cli`
([Install](../../how-to/install.md)).

Run `nauvi --help` or `nauvi <command> --help` for every option;
`nauvi --version` prints the installed version. The pages of this section
are generated from the same definitions as `--help`, so they match the
release they belong to.

## Global options

Every command takes:

| Option | What it does |
| --- | --- |
| `--context <NAME>` | Kubeconfig context to use (default: the current context) |
| `--kubeconfig <PATH>` | Kubeconfig file to read (default: `KUBECONFIG`, then `~/.kube/config`) |

So one script can work against several clusters. The CLI uses your
kubeconfig, or in-cluster config when it runs inside Kubernetes.

## Output and exit codes

Output is meant for scripts too:

- Results go to stdout; errors and log lines go to stderr (no colour unless
  stderr is a terminal).
- A failure exits with status 1, a usage error with 2.
- `get` with nothing to list prints "No resources found" on stderr and
  nothing on stdout.
- Table columns are sized to their content and two spaces apart; use
  `get -o name|json|yaml` for output to parse.
- `exec` exits with the remote command's exit code, like `kubectl exec` (1 if
  the command cannot be run).

## Namespaces

- Commands on one named object (`describe`, `yaml`, `get <kind> <name>`)
  default to the context's namespace.
- Lists default to all namespaces.
- Actions (`scale`, `restart`, `evict`, `trigger`…) default to the `default`
  namespace.

Errors from actions say plainly what happened: not allowed, already gone,
blocked by a PodDisruptionBudget.

## Commands

| Page | Commands |
| --- | --- |
| [Look at resources](inspect.md) | `get`, `describe`, `yaml`, `pods`, `namespaces`, `nodes`, `watch`, `top` |
| [Logs](logs.md) | `logs` |
| [Shells, debugging and port forwards](shells.md) | `exec`, `attach`, `debug`, `node-shell`, `port-forward` |
| [Actions](actions.md) | `scale`, `restart`, `cordon`, `uncordon`, `drain`, `evict`, `trigger`, `suspend`, `resume`, `delete`, `apply` |
| [Helm](helm.md) | `helm list`, `helm get` |
| [nauvi mcp](mcp.md) | `mcp` |
| [Shell completions](completions.md) | `completions` |

## Examples

```sh
nauvi get deploy -n kube-system
nauvi get pods -l app=web -o wide
nauvi get widgets.example.com              # a custom resource
nauvi describe deploy/web -n demo
nauvi logs deploy/web -n demo -f           # every pod of the Deployment, as [pod] line
nauvi exec web-7c9f -n demo -- cat /etc/hostname
nauvi port-forward svc/web 8080:80 -n demo
nauvi drain node-2 --timeout 300
nauvi apply -f app.yaml --dry-run
nauvi completions bash > ~/.local/share/bash-completion/completions/nauvi
```
