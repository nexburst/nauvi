# Debugging pods and nodes

## Debug a pod

**Debug…** on a pod adds an **ephemeral debug container** that sees a chosen
container's processes, and attaches to it in a dock tab.

- The image is `busybox:1.37` by default; pick another, for example
  `nicolaka/netshoot` for network tools.
- It works on images without a shell.
- The container stays in the pod until the pod is deleted: Kubernetes can't
  remove an ephemeral container.

## A shell on a node

**Shell** on a node opens a root shell on the host through a privileged pod
in `kube-system`. The pod is deleted when the tab closes or the app quits.
The namespace must allow privileged pods (Pod Security `privileged`).

## From the CLI

[`nauvi debug`](../cli/shells.md#nauvi-debug),
[`nauvi node-shell`](../cli/shells.md#nauvi-node-shell) and
[`nauvi attach`](../cli/shells.md#nauvi-attach) do the same from a terminal.
