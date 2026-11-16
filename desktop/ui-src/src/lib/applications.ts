// Pure helpers for the Applications view (#226): workloads grouped by the
// app.kubernetes.io labels and Helm releases (`src/applications.rs`).

import type { AppHealth, AppSource, Application } from "./bindings";
import type { Entry } from "./stores/keyed.svelte";
import type { Tone } from "./workloads";

/** `app.view` of the Applications view. */
export const APPLICATIONS_VIEW = "applications";

export function healthTone(h: AppHealth): Tone {
  switch (h) {
    case "Healthy":
      return "ok";
    case "Progressing":
      return "progress";
    case "Degraded":
      return "bad";
    default:
      return "idle";
  }
}

/** What the Source column says. */
export function sourceLabel(s: AppSource): string {
  switch (s) {
    case "Helm":
      return "Helm release";
    case "Instance":
      return "instance label";
    default:
      return "name label";
  }
}

/** A row of the applications store: the filter searches `text` (lowercased). */
export interface AppRow {
  key: string;
  text: string;
  app: Application;
}

/** The row of an application: its fields and its workloads' names are searched. */
export function appRow(a: Application): AppRow {
  const text = [
    a.key,
    sourceLabel(a.source),
    a.health,
    ...a.components,
    ...a.versions,
    ...a.managed_by,
    ...a.workloads.map((w) => `${w.kind} ${w.name}`),
  ]
    .join(" ")
    .toLowerCase();
  return { key: a.key, text, app: a };
}

/** The health order of the Status sort: worst first. */
const HEALTH_RANK: Record<AppHealth, number> = { Degraded: 0, Progressing: 1, Healthy: 2, Suspended: 3 };

export type AppSortKey = "name" | "namespace" | "health" | "workloads" | "age";
export interface AppSort {
  key: AppSortKey;
  dir: "asc" | "desc";
}

function sortValue(a: Application, key: AppSortKey): string | number {
  switch (key) {
    case "namespace":
      return a.namespace;
    case "health":
      return HEALTH_RANK[a.health];
    case "workloads":
      return a.workloads.length;
    case "age":
      // Youngest first when ascending, like an age column.
      return -a.created;
    default:
      return a.name;
  }
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** Filter by the search text, then sort (ties: by key). */
export function visibleApps(entries: readonly Entry<AppRow>[], search: string, sort: AppSort): Application[] {
  const q = search.trim().toLowerCase();
  const rows = (q ? entries.filter((e) => e.row.text.includes(q)) : entries).map((e) => e.row.app);
  const dir = sort.dir === "asc" ? 1 : -1;
  return rows.sort((a, b) => cmp(sortValue(a, sort.key), sortValue(b, sort.key)) * dir || cmp(a.key, b.key));
}

/** "2 Deployments, 1 StatefulSet". */
export function workloadSummary(a: Application): string {
  const counts = new Map<string, number>();
  for (const w of a.workloads) counts.set(w.kind, (counts.get(w.kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`).join(", ");
}

/** A click on a sortable header: the same column flips, another starts ascending. */
export function nextSort(sort: AppSort, key: AppSortKey): AppSort {
  return sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}
