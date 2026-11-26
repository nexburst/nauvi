// The order of the sidebar (#481): its sections, the kinds most sessions
// use first in each, the rest under "More", and what the filter keeps.

import type { Category, ResourceKind } from "./bindings";

/** The sections of built-in kinds, top to bottom. Helm goes after Cluster. */
export const SECTIONS: { category: Category; title: string }[] = [
  { category: "workloads", title: "Workloads" },
  { category: "network", title: "Network" },
  { category: "config", title: "Config" },
  { category: "storage", title: "Storage" },
  { category: "cluster", title: "Cluster" },
  { category: "access", title: "Access Control" },
  { category: "devices", title: "Device Resources" },
];

/**
 * The kinds shown without opening "More", by Kind, in this order. A
 * section not listed here (Storage, Cluster, Access Control: few kinds,
 * all in use) shows every kind; one listed with none (Device Resources)
 * keeps them all under "More".
 */
export const COMMON: Partial<Record<Category, string[]>> = {
  workloads: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"],
  network: ["Service", "Ingress"],
  config: ["ConfigMap", "Secret", "HorizontalPodAutoscaler"],
  devices: [],
};

type KindLike = Pick<ResourceKind, "category" | "crd"> & { resource: { kind: string } };

/** A section's kinds split into the common ones (in COMMON's order) and the rest (in theirs). */
export function splitCommon<K extends KindLike>(category: Category, list: readonly K[]): { common: K[]; more: K[] } {
  const order = COMMON[category];
  if (!order) return { common: [...list], more: [] };
  const rank = (k: K) => (k.crd ? -1 : order.indexOf(k.resource.kind));
  const common = list.filter((k) => rank(k) >= 0).sort((a, b) => rank(a) - rank(b));
  return { common, more: list.filter((k) => rank(k) < 0) };
}

/** The filter, lower case and trimmed ("" keeps everything). */
export function normalizeFilter(text: string): string {
  return text.trim().toLowerCase();
}

/** Whether any of `names` contains the filter. */
export function matches(filter: string, ...names: readonly string[]): boolean {
  return !filter || names.some((n) => n.toLowerCase().includes(filter));
}

/** The names a kind is found by: its label, Kind, plural and kubectl's short names. */
export function kindNames(k: Pick<ResourceKind, "label" | "short_names"> & { resource: { kind: string; plural: string } }): string[] {
  return [k.label, k.resource.kind, k.resource.plural, ...k.short_names];
}
