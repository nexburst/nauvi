// Pure helpers for the Workloads overview (#79): the per-kind status cards
// and what a click on a count opens.

import type { KindCounts, ResourceKind, WorkloadStatus } from "./bindings";

/** `app.view` of the Workloads overview. */
export const WORKLOADS_VIEW = "workloads";

/** How a status is coloured: fine, on its way, needs attention, done, idle. */
export type Tone = "ok" | "progress" | "bad" | "done" | "idle";

export function toneOf(status: WorkloadStatus): Tone {
  switch (status) {
    case "Running":
      return "ok";
    case "Pending":
      return "progress";
    case "Error":
    case "Failed":
      return "bad";
    case "Succeeded":
      return "done";
    default:
      return "idle";
  }
}

/** One part of a card's stacked bar, and its line in the legend. */
export interface Segment {
  status: WorkloadStatus;
  count: number;
  /** Share of the kind's objects, 0–100 (rounded to one decimal). */
  percent: number;
  tone: Tone;
}

/** The bar and legend of a card: every status the kind uses, zeros too. */
export function segments(k: KindCounts): Segment[] {
  return k.statuses.map((s) => ({
    status: s.status,
    count: s.count,
    percent: k.total > 0 ? Math.round((s.count / k.total) * 1000) / 10 : 0,
    tone: toneOf(s.status),
  }));
}

/** Whether a card needs attention: something failed or errors. */
export function needsAttention(k: KindCounts): boolean {
  return k.statuses.some((s) => toneOf(s.status) === "bad" && s.count > 0);
}

/**
 * The discovered kind (table) of a workload kind: the same group and kind,
 * the version discovery prefers.
 */
export function workloadKind(kinds: readonly ResourceKind[], group: string, kind: string): ResourceKind | undefined {
  return kinds.find((k) => k.resource.group === group && k.resource.kind === kind);
}

/** Whether a row passes the status filter (`""`: no filter). */
export function matchesStatus(row: { status: string }, status: string): boolean {
  return !status || row.status === status;
}
