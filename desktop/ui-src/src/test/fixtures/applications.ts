// Applications (#226) of the fake cluster, as `src/applications.rs` groups
// them: the Helm release `demo/web`, the `shop` instance (two workloads),
// a failed job found by its name label, and one in kube-system.

import type { Application, ApplicationsList, AppWorkload, WorkloadStatus } from "../../lib/bindings";
import type { FakeCluster } from "./cluster";

const ago = (secs: number) => Math.floor(Date.now() / 1000) - secs;

function workload(group: string, kind: string, namespace: string, name: string, status: WorkloadStatus, problem = ""): AppWorkload {
  return { group, kind, namespace, name, status, problem };
}

export function defaultApplications(): Application[] {
  return [
    {
      key: "demo/migrate",
      namespace: "demo",
      name: "migrate",
      source: "Name",
      components: ["migrate"],
      versions: [],
      managed_by: [],
      health: "Degraded",
      reason: "Job migrate: Failed (BackoffLimitExceeded)",
      workloads: [workload("batch", "Job", "demo", "migrate", "Failed", "Failed (BackoffLimitExceeded)")],
      created: ago(7200),
    },
    {
      key: "demo/shop",
      namespace: "demo",
      name: "shop",
      source: "Instance",
      components: ["api", "nightly"],
      versions: ["1.4.0"],
      managed_by: ["kustomize"],
      health: "Progressing",
      reason: "Deployment api: 1 of 3 ready",
      workloads: [
        workload("apps", "Deployment", "demo", "api", "Pending", "1 of 3 ready"),
        workload("batch", "CronJob", "demo", "nightly", "Suspended", "Suspended"),
      ],
      created: ago(86400 * 3),
    },
    {
      key: "demo/web",
      namespace: "demo",
      name: "web",
      source: "Helm",
      components: ["web"],
      versions: ["2.4"],
      managed_by: ["Helm"],
      health: "Healthy",
      reason: "",
      workloads: [workload("apps", "Deployment", "demo", "web", "Running")],
      created: ago(86400 * 10),
    },
    {
      key: "kube-system/coredns",
      namespace: "kube-system",
      name: "coredns",
      source: "Name",
      components: ["coredns"],
      versions: [],
      managed_by: [],
      health: "Healthy",
      reason: "",
      workloads: [workload("apps", "Deployment", "kube-system", "coredns", "Running")],
      created: ago(86400 * 30),
    },
  ];
}

/** The kinds the backend watches, by kind id, with their note label. */
const KINDS: [string, string][] = [
  ["apps/v1/deployments", "Deployments"],
  ["apps/v1/statefulsets", "StatefulSets"],
  ["apps/v1/daemonsets", "DaemonSets"],
  ["batch/v1/cronjobs", "CronJobs"],
  ["batch/v1/jobs", "Jobs"],
];

/**
 * The list for `namespaces` (empty: all), with the backend's RBAC notes: a
 * kind denied across all namespaces (`deniedClusterWide`) narrows to the
 * default namespace; a denied namespace is left out.
 */
export function applicationsList(cluster: FakeCluster, namespaces: readonly string[]): ApplicationsList {
  const notes: string[] = [];
  let shown = (ns: string) => namespaces.length === 0 || namespaces.includes(ns);
  const fallback = cluster.defaultNamespace ?? "default";
  if (namespaces.length === 0) {
    const narrowed = KINDS.filter(([id]) => cluster.deniedClusterWide.includes(id));
    for (const [, label] of narrowed) {
      notes.push(`${label}: showing namespace ${fallback} only (not allowed across all namespaces)`);
    }
    if (narrowed.length > 0) shown = (ns) => ns === fallback;
  } else {
    for (const ns of namespaces.filter((n) => cluster.deniedNamespaces.includes(n))) {
      for (const [, label] of KINDS) notes.push(`${label}: not allowed in namespace ${ns}`);
    }
  }
  const applications = cluster.applications.filter((a) => shown(a.namespace) && !cluster.deniedNamespaces.includes(a.namespace));
  return { applications: JSON.parse(JSON.stringify(applications)) as Application[], notes };
}
