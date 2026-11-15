// The Workloads overview (#79) of the fake cluster, computed from its rows
// like the backend computes it from its watches (`src/overview/workloads.rs`).

import type { KindCounts, ProblemWorkload, WorkloadStatus, WorkloadsOverview } from "../../lib/bindings";
import type { FakeCluster } from "./cluster";

/** The workload kinds in sidebar order, with the statuses each is counted in. */
const KINDS: { id: string; group: string; kind: string; statuses: WorkloadStatus[] }[] = [
  { id: "v1/pods", group: "", kind: "Pod", statuses: ["Running", "Pending", "Error", "Failed", "Succeeded"] },
  { id: "apps/v1/deployments", group: "apps", kind: "Deployment", statuses: ["Running", "Pending", "Failed"] },
  { id: "apps/v1/daemonsets", group: "apps", kind: "DaemonSet", statuses: ["Running", "Pending", "Failed"] },
  { id: "apps/v1/statefulsets", group: "apps", kind: "StatefulSet", statuses: ["Running", "Pending", "Failed"] },
  { id: "apps/v1/replicasets", group: "apps", kind: "ReplicaSet", statuses: ["Running", "Pending", "Failed"] },
  { id: "batch/v1/jobs", group: "batch", kind: "Job", statuses: ["Running", "Failed", "Succeeded", "Suspended"] },
  { id: "batch/v1/cronjobs", group: "batch", kind: "CronJob", statuses: ["Scheduled", "Running", "Suspended"] },
];

/**
 * The overview of `namespaces` (empty: all). A kind in `cluster.denied` is
 * left out with a note; problems are the non-pod rows that are Pending,
 * Failed or Suspended; warnings are the cluster overview's events about
 * workload kinds.
 */
export function workloadsOverview(cluster: FakeCluster, namespaces: readonly string[]): WorkloadsOverview {
  const shown = (ns: string) => namespaces.length === 0 || namespaces.includes(ns);
  const kinds: KindCounts[] = [];
  const problems: ProblemWorkload[] = [];
  const notes: string[] = [];
  for (const k of KINDS) {
    const kind = cluster.kinds.find((d) => d.id === k.id);
    if (!kind) continue;
    if (cluster.denied.includes(k.id)) {
      notes.push(`${kind.label}: not allowed to list them here`);
      continue;
    }
    const rows = (cluster.rows[k.id] ?? []).filter((r) => shown(r.namespace));
    kinds.push({
      group: k.group,
      kind: k.kind,
      total: rows.length,
      statuses: k.statuses.map((status) => ({ status, count: rows.filter((r) => r.status === status).length })),
    });
    if (k.kind === "Pod") continue;
    for (const r of rows) {
      const status = r.status as WorkloadStatus;
      if (!["Pending", "Failed", "Suspended"].includes(status)) continue;
      const ready = kind.columns.findIndex((c) => c.key === "ready");
      const reason =
        status === "Suspended"
          ? "Suspended"
          : status === "Failed"
            ? "Failed (BackoffLimitExceeded)"
            : `${r.cells[ready].replace("/", " of ")} ready`;
      problems.push({ group: k.group, kind: k.kind, namespace: r.namespace, name: r.name, status, reason, created: r.created });
    }
  }
  problems.sort((a, b) => Number(a.status !== "Failed") - Number(b.status !== "Failed"));
  const workload = new Set(KINDS.map((k) => `${k.group}|${k.kind}`));
  const events = (cluster.overview.events?.items ?? []).filter((e) => {
    const group = e.object_api_version.includes("/") ? e.object_api_version.split("/")[0] : "";
    return workload.has(`${group}|${e.object_kind}`) && shown(e.object_namespace);
  });
  return { kinds, problems, problems_total: problems.length, events, notes };
}
