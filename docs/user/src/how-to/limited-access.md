# Use a cluster you can only partly read

Many clusters give you access to a few namespaces only, or let you read but
not change. This page shows what nauvi does there and how to make it
comfortable.

## Tell nauvi which namespaces are yours

If you can't list namespaces, set them by hand: in the cluster's **Settings**,
fill in the **default and accessible namespaces**. The namespace picker then
offers those, and the views start in the default one.

You can show one namespace, several at once (up to 10, one watch each) or
all of them.

## What you can't do is greyed out

nauvi asks the API server what you may do (RBAC) before it offers it:

- **Kinds you aren't allowed to list** are greyed out in the drawer.
- **Actions you aren't allowed to run** are greyed out in the row menu, the
  detail panel, the selection bar and the command palette, and the keyboard
  `Delete` refuses them. The tooltip names the missing permission, for
  example *Not allowed: you can't delete pods in namespace demo*.
- Secret and ConfigMap data you may read but not patch, or an immutable
  object, is shown read-only.

## Errors say what was not allowed

When the cluster refuses something anyway, the error says what was not
allowed and where, in plain words, not a raw HTTP status. Some features name
what they need:

- **Evict** needs `create pods/eviction`.
- The Prometheus charts need `get` on `services/proxy` in Prometheus's
  namespace.
- The metrics-server and Prometheus installs create ClusterRoles and
  ClusterRoleBindings (metrics-server also an APIService), so they need
  permission to create those.

## The same in the CLI and MCP

The CLI and `nauvi mcp` act as your kubeconfig user, so RBAC applies there
too. Their errors say what was not allowed, what is already gone, or what
blocked it.

## Try it

The test cluster can make such a user:
`bash scripts/test-cluster/limited-user.sh` creates a ServiceAccount with
`edit` in `team-a` only and writes `~/.kube/nauvi-limited.yaml`. Start nauvi
with `KUBECONFIG=~/.kube/nauvi-limited.yaml` to see the app as that user.
