import type { Capacity, EventInfo, PodCounts, ProblemGroup, ResourceKind } from "./bindings";
import { formatCpu, formatMemory } from "./format";
import { PROBLEMS_STATUS } from "./workloads";

/** The Overview's budgets (#605): it fits one screen however big the cluster. */
export const GROUPS_SHOWN = 5;
export const WARNINGS_SHOWN = 5;
export const NAMESPACES_SHOWN = 10;

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

export interface PodCard {
  label: string;
  value: number;
  /** A count that needs attention. */
  alert: boolean;
  title: string;
  /** The status filter of the Pods view the card opens. */
  status: string;
  /** Failed or Succeeded at 0: a word in the muted line under the cards, not a card. */
  quiet: boolean;
}

/** The status cards, in order. */
export function podCards(p: PodCounts): PodCard[] {
  const card = (label: string, value: number, alert: boolean, title: string, status: string, quiet = false) => ({
    label,
    value,
    alert,
    title,
    status,
    quiet,
  });
  return [
    card("Running", p.running, false, "Running, without a waiting error", "Running"),
    card("Pending", p.pending, false, "Pending (scheduling, pulling, starting)", "Pending"),
    card(
      "Errors",
      p.waiting_errors,
      p.waiting_errors > 0,
      "A container waits on an error: CrashLoopBackOff, ImagePullBackOff, …",
      PROBLEMS_STATUS,
    ),
    card("Failed", p.failed, p.failed > 0, "Phase Failed (including evicted pods)", "Failed", p.failed === 0),
    card("Succeeded", p.succeeded, false, "Completed (Jobs)", "Succeeded", p.succeeded === 0),
  ];
}

/** "18 of 20 pods · 340 restarts"; a pod without an owner: "12 restarts". */
export function groupCounts(g: ProblemGroup): string {
  const parts: string[] = [];
  if (g.owner_kind) {
    const of = Math.max(g.owner_pods, g.count);
    parts.push(`${g.count} of ${of} pod${of === 1 ? "" : "s"}`);
  }
  if (g.restarts > 0) parts.push(`${g.restarts} restart${g.restarts === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** "See all 166 problem pods →", or "" when the rows already hold them all. */
export function seeAllProblems(pods: PodCounts): string {
  const shown = pods.groups.slice(0, GROUPS_SHOWN).reduce((n, g) => n + g.count, 0);
  if (pods.problems_total <= shown && pods.groups_total <= GROUPS_SHOWN) return "";
  return `See all ${pods.problems_total} problem pods →`;
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

/** The Overview's headline: how the cluster is, in plain words. */
export function deckHeadline(pods: PodCounts | null, context: string): { text: string; calm: boolean } {
  if (!pods) return { text: "Pods are not visible here", calm: true };
  const n = pods.problems_total;
  if (n === 0) return { text: context ? `No problems in ${context}` : "No problems", calm: true };
  return { text: `${n} pod${n === 1 ? " needs" : "s need"} a look`, calm: false };
}

/** The line above it: the context and what it covers ("kind-dev · all namespaces"). */
export function deckKicker(context: string, namespace: string | null): string {
  return [context, namespace ? `namespace ${namespace}` : "all namespaces"].filter(Boolean).join(" · ");
}
