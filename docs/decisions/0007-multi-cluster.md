# 0007: Many clusters per window, one session per (window, cluster)

**Status:** accepted (2026-11-16). Issue #333.

## Context
A window shows one context at a time and switching tears its session down:
streams stop, the client is dropped, the next cluster starts from nothing.
People with many contexts want a tree of clusters in one window, to keep
logs, terminals and forwards of one cluster running while they look at
another, without paying memory for clusters they are not using.

## Decision
- **State:** `AppState.sessions` becomes window -> `WindowClusters`
  (ClusterId -> `Arc<ClusterSession>`, plus which one is `visible`). A
  cluster's id is its context name. A session's context never changes, so
  switching opens (or reuses) another session. Only `KubeconfigSources` is
  shared between sessions; the context catalog is cached by fingerprint.
- **Commands carry the cluster:** the `Cluster` extractor reads a `cluster`
  key from the invoke payload. Its specta `FunctionArg` puts
  `cluster: string` in `bindings.ts` as the first parameter of every
  cluster-scoped command; the Rust signatures do not change (every command
  takes `cluster: Cluster` before its own arguments). The UI calls them as
  `api(id).cmdX(...)` (`lib/cluster.ts`); the others (settings, kubeconfig
  sources, helm repositories, the window) are listed in `GLOBAL_COMMANDS`
  and stay on `commands`. A Vitest check (`lib/cluster.test.ts`) keeps
  `cluster` first and the list in step with `bindings.ts`, and the fake
  backend refuses a cluster-scoped call without it. The UI drops replies
  for clusters that are no longer visible.
- **Events:** stream events keep their app-unique ids. A new
  `ClusterStateChanged { cluster, state, pinnedBy }` event reports
  connecting, connected, idle-disconnected and failed.
- **Lazy connect:** the tree comes from `cmd_list_contexts` without a
  client. Expanding a cluster's node calls `cmd_cluster_connect`. At
  startup only auto-start port-forwards connect their cluster.
- **Watches** run only for the visible cluster. Logs, terminals and
  port-forwards keep running in the others and are labelled with their
  cluster.
- **Idle disconnect:** a reaper runs every 30 s and disconnects a session
  that is not visible, not pinned (by a port-forward, exec or shell, log
  stream or drain) and untouched for `idle_disconnect_minutes`: **default
  10, 0 = never**. Disconnecting drops the client, the discovered kinds,
  the usage history and the caches; the next command reconnects.
  **Clusters whose exec plugin logs in through a browser** (OIDC/SSO, e.g.
  kubelogin, gke or aws sso) **are exempt**: a reconnect would open the
  browser again.
- **Exec consent** is unchanged from #201. A reconnect reuses the stored
  answer; a pending consent prompt shows inside the cluster's node.
- **Remove = hide:** removing a cluster from the tree adds it to
  `Settings.hidden_contexts`, with Show hidden and Unhide. kubeconfig files
  are never written; a gate test checks they stay byte-identical.

## Budget (enforced in CI)
- At most 5 MB backend RSS per idle connected cluster
  (`tests/cluster_budget.rs`, 6 contexts pointing at kind).
- At most 15 MB for the whole app (QA scenario `multicluster`).
- With 50 contexts, 49 of them unreachable, the tree shows in at most
  1.5 s, and at most 200 ms slower than with 1 context.
- No cluster command runs before a click (Playwright).

## Rollout
1. The command contract (above) and this record, alone: it touches every
   UI file that calls a command, so other branches rebase after it. The
   backend requires the `cluster` value but still has one session per
   window.
2. Sessions per (window, cluster).
3. The tree UI and consent per node (alongside 4).
4. Idle disconnect.
5. Hide, and cluster labels in the dock and the port-forwards.
6. The budgets in CI.

## Consequences and risks
- Single UI stores must reset fully on a switch; an A -> B -> A test checks
  it.
- Browser-login plugins could reopen a browser after an idle disconnect,
  hence the exemption.
- The port-forward helpers walk the nested map and need tests.
- RSS measured on CI runners is noisy: the budget takes the median of 3
  runs.
