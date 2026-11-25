// The Overview feed and its usage chart (`commands/overview.rs`).

import type { OverviewUsageView } from "../../lib/bindings";
import { prometheusStatus } from "./prometheus";
import { copy, sendOverview } from "./state";
import type { AreaHandlers, FakeState } from "./state";

/** Like `cmd_overview_usage`: the last hour from Prometheus, else nothing and why. */
function overviewUsage(s: FakeState): OverviewUsageView {
  const { cluster } = s;
  const view: OverviewUsageView = { samples: [], source: "metrics_server", prometheus: "", note: "" };
  const ctx = cluster.contexts.find((c) => c.current)?.name ?? "";
  if (cluster.settings.contexts[ctx]?.hide_metrics) return { ...view, note: "Metrics are hidden for this cluster." };
  const status = prometheusStatus(s);
  if (!status.target) return view;
  view.prometheus = status.target;
  if (cluster.prometheus.failure) return { ...view, note: cluster.prometheus.failure };
  const history = cluster.prometheus.series["cluster|1h"];
  if (!history?.samples.length) {
    const note = `Prometheus at ${status.target} has no CPU and memory samples of the nodes in the last hour.`;
    return { ...view, note };
  }
  return { ...view, samples: copy(history.samples), source: "prometheus" };
}

export function overviewHandlers(s: FakeState) {
  return {
    cmdOverviewStart: (id, _namespace, onEvent) => {
      s.overviewFeeds.add(id);
      s.overviewChannels.set(id, onEvent);
      s.lastOverview = id;
      // Like the backend: the first summary, then "live".
      setTimeout(() => {
        if (!s.overviewFeeds.has(id)) return;
        sendOverview(s, id, { type: "update", overview: s.cluster.overview });
        sendOverview(s, id, { type: "state", state: "live" });
      }, 0);
      return null;
    },
    cmdOverviewStop: (id) => {
      s.overviewFeeds.delete(id);
      return null;
    },
    cmdOverviewUsage: () => overviewUsage(s),
  } satisfies AreaHandlers;
}
