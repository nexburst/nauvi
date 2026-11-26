# Helm

The **Helm** section of the sidebar (after **Cluster**) has releases and
charts.

## Releases

The list shows each release with its chart, app version, revision and
status, read straight from the cluster: no `helm` binary is needed, and the
list reads only labels.

A release's detail shows:

- its notes;
- its values, optionally merged with the chart defaults;
- the rendered manifest, with Secret values hidden until you reveal them;
- the revision history, with a diff of any two revisions;
- the objects the release created.

**Rollback** and **Uninstall** run the `helm` CLI (on `PATH`) against the same
context, after a confirmation. **Upgrade** takes edited values and a chosen
version, shows a server-side dry run (a diff against the current revision)
and runs nothing until you confirm. The dry run says which objects would
change, for example "1 of 3 objects would change (ConfigMap web)" or "none
of the 3 objects would change". Nothing is applied until you click
**Upgrade**.

## Charts

**Helm → Charts** lists the charts in your chart repositories (the same ones
as the `helm` command line), with each version's README and default values.

- Add, update and remove repositories there or in Settings. With no
  repository yet, the page offers to add **bitnami**,
  **prometheus-community** or **ingress-nginx** in one click, or any other by
  name and URL.
- **Install** a chart with edited values into a namespace (created if
  missing). A server-side dry run shows the rendered manifest first and
  says how many objects would be created; nothing runs until you click
  **Install**.

Helm actions on a context from an added kubeconfig use a private copy of
that context, deleted when the command ends
([The dock and terminals](dock.md#local-terminal)).

The CLI reads releases too: [`nauvi helm`](../cli/helm.md).
