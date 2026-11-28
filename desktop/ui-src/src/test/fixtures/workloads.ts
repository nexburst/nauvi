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
  const problems: (ProblemWorkload & { affected: number })[] = [];
  const notes: string[] = [];
  for (const k of KINDS) {
    const kind = cluster.kinds.find((d) => d.id === k.id);
    if (!kind) continue;
    if (cluster.denied.includes(k.id)) {
      notes.push(`${kind.label}: not allowed to list them here`);
      continue;
    }
    const rows = (cluster.rows[k.id] ?? []).filter((r) => shown(r.namespace));
    const before = problems.length;
    for (const r of k.kind === "Pod" ? [] : rows) {
      const status = r.status as WorkloadStatus;
      if (!["Pending", "Failed", "Suspended"].includes(status)) continue;
      const readyCell = r.cells[kind.columns.findIndex((c) => c.key === "ready")] ?? "";
      const [ready, desired] = readyCell.split("/").map(Number);
      const reason =
        status === "Suspended"
          ? "Suspended"
          : status === "Failed"
            ? "Failed (BackoffLimitExceeded)"
            : `${readyCell.replace("/", " of ")} ready`;
      const affected = Math.max(0, (desired || 0) - (ready || 0));
      const created = r.created;
      problems.push({ group: k.group, kind: k.kind, namespace: r.namespace, name: r.name, status, reason, created, affected });
    }
    kinds.push({
      group: k.group,
      kind: k.kind,
      total: rows.length,
      problems: problems.length - before,
      statuses: k.statuses.map((status) => ({ status, count: rows.filter((r) => r.status === status).length })),
    });
  }
  // Errors first, then the most pods affected, then the oldest; the first five.
  const fine = (p: ProblemWorkload) => Number(p.status !== "Failed");
  problems.sort((a, b) => fine(a) - fine(b) || b.affected - a.affected || a.created - b.created);
  const listed = problems.slice(0, MAX_PROBLEMS).map(({ affected: _, ...p }) => p);
  const owners = new Set(listed.map((p) => `${p.namespace}/${p.kind}/${p.name}`));
  const workload = new Set(KINDS.map((k) => `${k.group}|${k.kind}`));
  const events = (cluster.overview.events?.items ?? []).filter((e) => {
    const group = e.object_api_version.includes("/") ? e.object_api_version.split("/")[0] : "";
    // A listed problem's pods: its row says it already.
    if (e.object_kind === "Pod" && owners.has(`${e.object_namespace}/${e.owner_kind}/${e.owner_name}`)) return false;
    return workload.has(`${group}|${e.object_kind}`) && shown(e.object_namespace);
  });
  // The newest 20, like the backend's EVENTS_SHOWN.
  events.sort((a, b) => b.time - a.time);
  return { kinds, problems: listed, problems_total: problems.length, events: events.slice(0, 20), notes };
}

/** `MAX_PROBLEMS` in `src/overview/workloads.rs`. */
const MAX_PROBLEMS = 5;
