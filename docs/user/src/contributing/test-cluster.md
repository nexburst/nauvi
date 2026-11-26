# The test cluster

`bash scripts/test-cluster/setup.sh` creates a local test cluster with
[kind](https://kind.sigs.k8s.io/) (Kubernetes IN Docker): real nodes running
real containers, so logs, exec, port forwarding and the CPU and memory
columns all work end to end. It needs Docker, usable by your user without
`sudo`. The script installs `kind` and `kubectl` into `~/.local/bin` if they
are missing.

It creates `nauvi-test` (a control-plane node and a worker) with:

- metrics-server, patched with `--kubelet-insecure-tls` (which kind's
  self-signed kubelet certificates need), so the usage columns and
  `nauvi top` work; the numbers appear about a minute after it starts;
- the demo workload (`scripts/test-cluster/demo.yaml`) in namespace `demo`:
  the `web` (nginx) and `logger` Deployments (the logger writes a line every
  2 s, handy for live logs), a two-container pod (`multi`), a crash-looping
  pod (`crashed`), and in `default` a pod that stays Pending (`hungry`).

The screenshots in these docs come from this cluster.

`scripts/test-cluster/charts/demo-chart` is a tiny local chart (a ConfigMap,
a Secret and a Deployment) for the Helm tests, which install it in temporary
namespaces with `helm`. `tests/helm_charts_cluster.rs` also packages it as a
chart repository served from 127.0.0.1, with helm pointed at temporary
configuration directories, so it never touches your own repositories.

Pass `--staging` to also create `nauvi-staging`, a single empty node, so the
context switcher has a second cluster to switch to. Each kind cluster costs
roughly 500 MB to 1 GB of RAM, which is why it is opt-in.

kind adds the contexts (`kind-nauvi-test`, `kind-nauvi-staging`) to
`~/.kube/config`, and the script leaves `kind-nauvi-test` current.

Delete the clusters with `kind delete cluster --name nauvi-test` (and
`nauvi-staging`); run the script again to recreate them.

## A user with limited rights

`bash scripts/test-cluster/limited-user.sh` creates a ServiceAccount with
`edit` in `team-a` only and writes a separate kubeconfig,
`~/.kube/nauvi-limited.yaml` (it never touches `~/.kube/config`). Try the
app as that user with `KUBECONFIG=~/.kube/nauvi-limited.yaml`. The token
lasts 24 hours; run the script again to refresh it.
