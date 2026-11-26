# Login commands

Many clusters log in by running a command, an **exec credential plugin**:
EKS (`aws eks get-token`), GKE (`gke-gcloud-auth-plugin`), AKS
(`kubelogin`), and others. nauvi runs it when it logs in to the cluster.

- The credential is cached per plugin configuration (command, arguments and
  environment) and reused until it expires.
- The catalog checks these contexts only when you click **Check**, not each
  time it opens.

## Commands from your default kubeconfig

Commands from your default kubeconfig (`KUBECONFIG` or `~/.kube/config`) run
without asking, as in `kubectl`.

## Commands from an added kubeconfig

When an added kubeconfig file, folder or pasted kubeconfig logs in by running
a command, nauvi shows the exact command first and runs it only if you choose
**Allow and check**. **Don't run** marks its contexts "Not allowed".

- The answer is remembered per source and command, in `exec-approvals.json`
  in the app's config directory, until you remove the source. A changed
  command asks again.
- In the cluster tree, such a cluster asks inside its own row before the
  command runs.

## Keeping background clusters connected

A login command that may ask you something (a browser login, a prompt) keeps
its cluster connected in the background, so it does not ask again. See
[Background clusters](clusters.md#background-clusters) for the commands
known not to ask.

## When a login fails

See [Troubleshooting](../../troubleshooting.md#a-login-command-fails).
