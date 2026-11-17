// The overview's 1-hour CPU and memory chart (#328). With a Prometheus the
// backend sends the last hour; without one, the chart shows what this window
// sampled from the overview's metrics-server usage while it was open.

import type { Capacity, OverviewUsageView, UsageSample } from "./bindings";
import { clockTime } from "./usage";
import type { RefLine, Resource } from "./usage";

/** How far back the chart goes. */
export const CLUSTER_WINDOW_MS = 60 * 60 * 1000;
/** Samples closer together are dropped; the overview polls usage every 30 s. */
export const CLUSTER_SPACING_MS = 15_000;

/**
 * `samples` with `s` added (unless the last one is too recent) and those
 * older than the window dropped. A new array when it changed, else the same.
 */
export function addSample(samples: readonly UsageSample[], s: UsageSample): readonly UsageSample[] {
  const last = samples.at(-1);
  if (last && s.t < last.t + CLUSTER_SPACING_MS) return samples;
  const oldest = s.t - CLUSTER_WINDOW_MS;
  return [...samples.filter((x) => x.t >= oldest), s];
}

/** Per context; lives as long as the window. */
const sampled = new Map<string, readonly UsageSample[]>();

/** Record the usage of an overview summary, if it has any. */
export function recordClusterUsage(context: string, c: Capacity, now: number = Date.now()): readonly UsageSample[] {
  const before = sampled.get(context) ?? [];
  if (!c.metrics) return before;
  const after = addSample(before, { t: now, cpu_millicores: c.cpu_usage_millicores, memory_bytes: c.memory_usage_bytes });
  sampled.set(context, after);
  return after;
}

/** What this window sampled for `context`, within the last hour of `now`. */
export function sampledClusterUsage(context: string, now: number = Date.now()): readonly UsageSample[] {
  const oldest = now - CLUSTER_WINDOW_MS;
  return (sampled.get(context) ?? []).filter((s) => s.t >= oldest);
}

/** For tests. */
export function clearClusterUsage() {
  sampled.clear();
}

/** What the chart shows: its samples, where they come from, and a note. */
export interface ClusterChart {
  samples: readonly UsageSample[];
  source: string;
  note: string;
}

/**
 * Prometheus' samples when it sent some, else the ones sampled here, with
 * the line that says which. `view` is null until the backend answered.
 */
export function clusterChart(view: OverviewUsageView | null, local: readonly UsageSample[]): ClusterChart {
  if (view?.source === "prometheus" && view.samples.length > 0) {
    return { samples: view.samples, source: `Last hour, from Prometheus (${view.prometheus}).`, note: "" };
  }
  const source =
    local.length > 0
      ? `Sampled from metrics-server while this window is open, since ${clockTime(local[0].t)} (at most an hour).`
      : "Sampled from metrics-server while this window is open: the first sample comes with the next usage poll.";
  const note = view?.note ? `${view.note} Showing the metrics-server samples instead.` : "";
  return { samples: local, source, note };
}

/**
 * The chart's dashed lines: the requests and limits that are set.
 * Allocatable is left out (the bars show it): on most clusters it is far
 * above the usage and would flatten the line. When some containers have no
 * limit the limits are no ceiling: that line is "limits set", in grey.
 */
export function clusterRefs(c: Capacity, r: Resource): RefLine[] {
  const limit = (unlimited: number) => (unlimited > 0 ? "limits set" : "limit");
  const lines: RefLine[] =
    r === "cpu"
      ? [
          { label: "request", value: c.cpu_requests_millicores },
          { label: limit(c.cpu_unlimited_containers), value: c.cpu_limits_millicores },
        ]
      : [
          { label: "request", value: c.memory_requests_bytes },
          { label: limit(c.memory_unlimited_containers), value: c.memory_limits_bytes },
        ];
  return lines.filter((l) => l.value > 0);
}
