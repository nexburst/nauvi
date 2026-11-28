// Overview fixtures (#605): Problem groups the way `src/overview/summary.rs`
// builds them, and a cluster with many problems for the one-screen budget.

import type { EventInfo, PodCounts_Serialize as PodCounts, ProblemGroup, ProblemPod } from "../../lib/bindings";

const isError = (p: ProblemPod) => p.reason === p.status && p.status !== "Pending";

/**
 * Like `problem_groups` in summary.rs: the pods of one owner with one reason
 * ("Pending for …" alike) are one group, errors first, then the most pods.
 * `ownerPods` is how many pods each `namespace/kind/name` owner has.
 */
export function problemGroups(
  problems: readonly ProblemPod[],
  ownerPods: Record<string, number> = {},
  events: readonly EventInfo[] = [],
): { groups: ProblemGroup[]; groups_total: number } {
  const byKey = new Map<string, ProblemGroup>();
  for (const p of problems) {
    const alone = !p.owner_kind;
    const kind = alone ? "Pod" : p.owner_kind;
    const name = alone ? p.name : p.owner_name;
    const reason = p.reason.startsWith("Pending for ") ? "Pending" : p.reason;
    const key = `${p.namespace}/${kind}/${name}/${reason}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        namespace: p.namespace,
        owner_kind: alone ? "" : kind,
        owner_name: alone ? "" : name,
        reason: p.reason,
        error: isError(p),
        count: 0,
        owner_pods: alone ? 1 : (ownerPods[`${p.namespace}/${kind}/${name}`] ?? 1),
        restarts: 0,
        pods: [],
        events: [],
      };
      byKey.set(key, g);
    }
    g.count += 1;
    g.restarts += p.restarts;
    if (g.pods.length < 50) g.pods.push(p);
  }
  const all = [...byKey.values()];
  for (const g of all) {
    if (!g.owner_kind) continue;
    const names = new Set(g.pods.map((p) => p.name));
    g.events = events
      .filter((e) => e.object_kind === "Pod" && e.object_namespace === g.namespace && names.has(e.object_name))
      .slice(0, 5);
  }
  all.sort(
    (a, b) =>
      Number(!a.error) - Number(!b.error) || b.count - a.count || b.restarts - a.restarts || (a.key < b.key ? -1 : 1),
  );
  return { groups: all.slice(0, 5), groups_total: all.length };
}

export function warning(over: Partial<EventInfo> & { key: string }): EventInfo {
  return {
    kind: "Warning",
    reason: "BackOff",
    message: "",
    object: `${over.object_kind ?? "Pod"}/${over.object_name ?? "x"}`,
    object_api_version: "v1",
    object_kind: "Pod",
    object_namespace: "demo",
    object_name: "x",
    time: 0,
    count: 1,
    owner_kind: "",
    owner_name: "",
    ...over,
  };
}

const UID = "3f2a9c1e-0b4d-4e5f-8a6b-7c8d9e0f1a2b";

/**
 * The audit's big cluster (#609): 166 problem pods across 11 workloads and
 * 20 long warnings, 2,887 pods in 40 namespaces.
 */
export function manyProblems(now = Math.floor(Date.now() / 1000)): { pods: PodCounts; events: EventInfo[] } {
  const workloads: [string, string, string, string, number, number][] = [
    // namespace, kind, name, reason, problem pods, pods in all
    ["payments", "Deployment", "payments-worker", "CrashLoopBackOff", 40, 42],
    ["pm", "Deployment", "pm-inserter-celery", "CrashLoopBackOff", 30, 30],
    ["search", "StatefulSet", "elastic", "ImagePullBackOff", 20, 24],
    ["batch", "Job", "nightly-export", "Error", 18, 18],
    ["web", "Deployment", "storefront", "Not ready", 15, 20],
    ["web", "Deployment", "checkout", "CreateContainerConfigError", 12, 12],
    ["ml", "Deployment", "trainer", "Pending for 2h", 10, 10],
    ["ops", "DaemonSet", "log-shipper", "CrashLoopBackOff", 8, 40],
    ["data", "StatefulSet", "kafka", "Not ready", 6, 9],
    ["data", "Deployment", "etl", "OOMKilled", 4, 6],
    ["misc", "ReplicaSet", "legacy", "Pending for 3h", 3, 3],
  ];
  const problems: ProblemPod[] = [];
  const ownerPods: Record<string, number> = {};
  for (const [ns, kind, name, reason, n, all] of workloads) {
    ownerPods[`${ns}/${kind}/${name}`] = all;
    for (let i = 0; i < n; i++) {
      const pending = reason.startsWith("Pending");
      problems.push({
        namespace: ns,
        name: `${name}-7d9f8c6b5-${i.toString(36).padStart(5, "x")}`,
        status: pending ? "Pending" : reason === "Not ready" ? "Running" : reason,
        reason,
        restarts: pending || reason === "Not ready" ? 0 : 3 + i,
        created: now - 7200,
        owner_kind: kind,
        owner_name: name,
      });
    }
  }
  const events: EventInfo[] = Array.from({ length: 20 }, (_, i) => {
    const node = `node-${i}`;
    return warning({
      key: `default/w${i}`,
      reason: i % 2 ? "FailedScheduling" : "NodeNotReady",
      message:
        i % 2
          ? `0/24 nodes are available: 3 Insufficient cpu, 5 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 16 node(s) didn't match Pod's node affinity/selector. preemption: 0/24 nodes are available: 24 Preemption is not helpful for scheduling.`
          : `Node ${node} status is now: NodeNotReady; the kubelet stopped posting node status for pod web-x_web(${UID})`,
      object_kind: i % 2 ? "Pod" : "Node",
      object_api_version: "v1",
      object: i % 2 ? `Pod/queue-${i}` : `Node/${node}`,
      object_namespace: i % 2 ? "queue" : "",
      object_name: i % 2 ? `queue-${i}` : node,
      time: now - 60 * i,
      count: 10 + i,
    });
  });
  const { groups, groups_total } = problemGroups(problems, ownerPods);
  const by_namespace: [string, number][] = Array.from({ length: 40 }, (_, i) => [`ns-${i}`, 200 - i * 4]);
  return {
    pods: {
      namespace: null,
      total: 2887,
      running: 2700,
      pending: 13,
      succeeded: 8,
      failed: 18,
      waiting_errors: 130,
      by_namespace,
      problems: problems.slice(0, 50),
      problems_total: problems.length,
      groups,
      groups_total,
    },
    events,
  };
}
