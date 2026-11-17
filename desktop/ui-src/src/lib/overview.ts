import type { Capacity, EventInfo, PodCounts, ResourceKind } from "./bindings";
import { formatCpu, formatMemory } from "./format";

/** One bar of the capacity section. */
export interface CapacityBar {
  label: string;
  /** "1.2 / 8 requested" */
  text: string;
  /** 0–100, capped; what the bar fills to. */
  percent: number;
  /** Usage from metrics, when available ("900m used, 11%"). */
  usage: string;
  /** Over 90% of what can be allocated. */
  high: boolean;
  /** The limits set ("4 limits (50%)"; the percent is not capped), "no limits", or "" for pods. */
  limits: string;
  /** Where the limit marker sits on the bar (0–100, capped), or null. */
  limitPercent: number | null;
  /** The limits add up to more than can be allocated. */
  overcommitted: boolean;
  /**
   * Some running containers have no limit, so the limits are no ceiling:
   * the marker is drawn hollow and the text says how many.
   */
  partial: boolean;
}

export function percent(used: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

/** Like {@link percent}, but over 100 when `used` is over `total`. */
export function rawPercent(used: number, total: number): number {
  if (!total) return 0;
  return Math.round((used / total) * 100);
}

/** "1 container without a limit", "14 containers without a limit". */
export function unlimitedText(n: number): string {
  return `${n} container${n === 1 ? "" : "s"} without a limit`;
}

/**
 * CPU, memory and pod bars, Lens style: requests against allocatable, with
 * the limits (a marker on the bar) and the usage when metrics are there.
 */
export function capacityBars(c: Capacity): CapacityBar[] {
  const bar = (
    label: string,
    used: number,
    limits: number,
    total: number,
    fmt: (n: number) => string,
    usage: number | null,
    unlimited: number,
  ): CapacityBar => {
    const p = percent(used, total);
    const without = unlimited > 0 ? ` · ${unlimitedText(unlimited)}` : "";
    return {
      label,
      text: `${fmt(used)} / ${fmt(total)} requested (${p}%)`,
      percent: p,
      usage: usage === null ? "" : `${fmt(usage)} used (${percent(usage, total)}%)`,
      high: p > 90,
      limits: limits > 0 ? `${fmt(limits)} limits (${rawPercent(limits, total)}%)${without}` : "no limits",
      limitPercent: limits > 0 && total > 0 ? percent(limits, total) : null,
      overcommitted: total > 0 && limits > total,
      partial: unlimited > 0,
    };
  };
  const cpuUsage = c.metrics ? c.cpu_usage_millicores : null;
  const memUsage = c.metrics ? c.memory_usage_bytes : null;
  const pods = percent(c.pods, c.pods_allocatable);
  return [
    bar(
      "CPU",
      c.cpu_requests_millicores,
      c.cpu_limits_millicores,
      c.cpu_allocatable_millicores,
      formatCpu,
      cpuUsage,
      c.cpu_unlimited_containers,
    ),
    bar(
      "Memory",
      c.memory_requests_bytes,
      c.memory_limits_bytes,
      c.memory_allocatable_bytes,
      formatMemory,
      memUsage,
      c.memory_unlimited_containers,
    ),
    {
      label: "Pods",
      text: `${c.pods} / ${c.pods_allocatable} (${pods}%)`,
      percent: pods,
      usage: "",
      high: pods > 90,
      limits: "",
      limitPercent: null,
      overcommitted: false,
      partial: false,
    },
  ];
}

/** The status cards, in order. `alert` marks counts that need attention. */
export function podCards(p: PodCounts): { label: string; value: number; alert: boolean; title: string }[] {
  return [
    { label: "Running", value: p.running, alert: false, title: "Running, without a waiting error" },
    { label: "Pending", value: p.pending, alert: false, title: "Pending (scheduling, pulling, starting)" },
    {
      label: "Errors",
      value: p.waiting_errors,
      alert: p.waiting_errors > 0,
      title: "A container waits on an error: CrashLoopBackOff, ImagePullBackOff, …",
    },
    { label: "Failed", value: p.failed, alert: p.failed > 0, title: "Phase Failed (including evicted pods)" },
    { label: "Succeeded", value: p.succeeded, alert: false, title: "Completed (Jobs)" },
  ];
}

/**
 * The kind an event's object belongs to, if discovery knows it. Events
 * carry `apiVersion` + `kind`; the version may be one discovery does not
 * prefer, so fall back to the group alone.
 */
export function eventKind(e: EventInfo, kinds: ResourceKind[]): ResourceKind | undefined {
  if (!e.object_kind || !e.object_name) return undefined;
  const v = e.object_api_version || "v1";
  const [group, version] = v.includes("/") ? v.split("/") : ["", v];
  const same = (k: ResourceKind) => k.resource.group === group && k.resource.kind === e.object_kind;
  return kinds.find((k) => same(k) && k.resource.version === version) ?? kinds.find(same);
}

/** The footer count: "5 pods, 2 nodes". */
export function overviewCount(pods: PodCounts | null, nodes: { total: number } | null): string {
  const parts = [];
  if (pods) parts.push(`${pods.total} pods`);
  if (nodes) parts.push(`${nodes.total} nodes`);
  return parts.join(", ");
}
