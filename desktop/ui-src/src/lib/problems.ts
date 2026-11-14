// Problem badges in the sidebar: how many objects of a kind need attention
// (crash-looping pods, workloads short of ready replicas, nodes not ready).
//
// They only count what a running watch already delivers, never an extra
// request: the table on screen (its rows carry `problem`, set by the
// backend) and, while the Overview is open, its pod and node counts. When
// that watch stops, the last count stays, marked as stale. The store is
// `stores/problems.svelte.ts`.

import type { NodeCounts, PodCounts, ResourceRow } from "./bindings";

/** Where a badge's count came from. */
export type BadgeSource = "table" | "overview";

export interface Badge {
  count: number;
  /** "in demo", "in demo, web", "across all namespaces", "" (cluster scoped). */
  scope: string;
  source: BadgeSource;
  /** False once the watch that counted it has stopped. */
  live: boolean;
  /** When it was counted (epoch ms). */
  at: number;
}

export const POD_KIND_ID = "v1/pods";
export const NODE_KIND_ID = "v1/nodes";

/** How many rows are problems. */
export function countProblems(rows: Iterable<{ row: Pick<ResourceRow, "problem"> }>): number {
  let n = 0;
  for (const e of rows) if (e.row.problem) n++;
  return n;
}

/** The scope words of a count over `namespaces` (empty: all of them). */
export function scopeText(namespaced: boolean, namespaces: readonly string[]): string {
  if (!namespaced) return "";
  return namespaces.length === 0 ? "across all namespaces" : `in ${namespaces.join(", ")}`;
}

/** The Pods and Nodes badges the Overview's counts give. */
export function overviewBadges(
  pods: Pick<PodCounts, "namespace" | "problems_total"> | null,
  nodes: NodeCounts | null,
): { kindId: string; count: number; scope: string }[] {
  const out = [];
  if (pods) {
    out.push({
      kindId: POD_KIND_ID,
      count: pods.problems_total,
      scope: pods.namespace ? `in ${pods.namespace}` : "across all namespaces",
    });
  }
  if (nodes) out.push({ kindId: NODE_KIND_ID, count: nodes.total - nodes.ready, scope: "" });
  return out;
}

/** "3 Pods need attention in demo", plus how old it is once stale. */
export function badgeTitle(b: Badge, label: string, now: number): string {
  const what = `${b.count} ${b.count === 1 ? singular(label) : label} ${b.count === 1 ? "needs" : "need"} attention`;
  const text = b.scope ? `${what} ${b.scope}` : what;
  if (b.live) return text;
  const mins = Math.max(0, Math.round((now - b.at) / 60_000));
  const ago = mins < 1 ? "just now" : `${mins}m ago`;
  return `${text} (when last watched, ${ago}; open the view to update)`;
}

function singular(label: string): string {
  if (label.endsWith("ies")) return label.slice(0, -3) + "y";
  return label.endsWith("s") ? label.slice(0, -1) : label;
}
