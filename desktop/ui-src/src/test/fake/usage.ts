// Usage history of pods and nodes (`commands/usage.rs`) and of workloads
// (`commands/workload_usage.rs`).

import type { UsageHistoryView, UsageRange } from "../../lib/bindings";
import { NO_REFERENCE } from "../fixtures/usage";
import { prometheusStatus } from "./prometheus";
import { copy } from "./state";
import type { AreaHandlers, FakeState } from "./state";

/** Like `cmd_usage_history`: a Prometheus range, else the live history and why. */
function usageHistory(s: FakeState, key: string, subject: string, range: UsageRange): UsageHistoryView {
  const { cluster } = s;
  const base = cluster.usage[key] ?? {
    history: { since: 0, samples: [], containers: [] },
    reference: copy(NO_REFERENCE),
  };
  const status = prometheusStatus(s);
  const live: UsageHistoryView = {
    ...copy(base),
    source: "metrics_server",
    range: "live",
    prometheus: status.target,
    note: "",
  };
  if (range === "live") return live;
  if (!status.target) return { ...live, note: status.note };
  if (cluster.prometheus.failure) return { ...live, note: cluster.prometheus.failure };
  const history = cluster.prometheus.series[`${key}|${range}`];
  if (!history?.samples.length) {
    const note = `Prometheus at ${status.target} has no CPU and memory samples for ${subject} in the last ${range}.`;
    return { ...live, note };
  }
  return { ...live, history: copy(history), source: "prometheus", range };
}

export function usageHandlers(s: FakeState) {
  return {
    cmdUsageHistory: (what, namespace, name, range) => {
      const key = what === "pods" ? `pods|${namespace}/${name}` : `nodes|${name}`;
      return usageHistory(s, key, what === "pods" ? "this pod" : "this node", range);
    },
    cmdWorkloadUsageHistory: (kind, namespace, name, range) =>
      usageHistory(s, `workloads|${kind}|${namespace}/${name}`, `the pods of this ${kind}`, range),
  } satisfies AreaHandlers;
}
