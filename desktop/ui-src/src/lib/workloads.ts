// Pure helpers for the Workloads overview (#79): the per-kind status cards
// and what a click on a count opens.

import type { KindCounts, ResourceKind, WorkloadStatus } from "./bindings";
import { joinNames } from "./namespaces";

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
/** The status filter that keeps only the rows that need attention. */
export const PROBLEMS_STATUS = "needs attention";

export function matchesStatus(row: { status: string; problem?: string }, status: string): boolean {
  if (status === PROBLEMS_STATUS) return !!row.problem;
  return !status || row.status === status;
}

/** Problem workloads the Workloads overview lists (#606); the rest are one link away. */
export const PROBLEMS_SHOWN = 5;

/** The deck's headline: "41 workloads need a look", or calm. */
export function workloadsHeadline(problems: number, context: string): { text: string; calm: boolean } {
  if (problems === 0) return { text: context ? `No workload problems in ${context}` : "No workload problems", calm: true };
  return { text: `${problems} workload${problems === 1 ? " needs" : "s need"} a look`, calm: false };
}

/** The line above it: the context and the namespaces ("kind-dev · namespaces a and b"). */
export function workloadsKicker(context: string, namespaces: readonly string[]): string {
  const n = namespaces.length;
  const scope = n === 0 ? "all namespaces" : `namespace${n > 1 ? "s" : ""} ${joinNames(namespaces)}`;
  return [context, scope].filter(Boolean).join(" · ");
}

/** One "See all" link: a kind's table, filtered to its problems. */
export interface SeeAllLink {
  group: string;
  kind: string;
  count: number;
  /** The status filter that shows them: a suspended CronJob is no row problem. */
  status: string;
}

/**
 * Where "See all N →" goes when there are more problems than are listed:
 * one link per kind with problems, most first. Empty when all are listed.
 */
export function seeAllWorkloads(o: {
  kinds: readonly KindCounts[];
  problems: readonly unknown[];
  problems_total: number;
}): SeeAllLink[] {
  if (o.problems_total <= Math.min(o.problems.length, PROBLEMS_SHOWN)) return [];
  return o.kinds
    .filter((k) => k.problems > 0)
    .map((k) => ({
      group: k.group,
      kind: k.kind,
      count: k.problems,
      status: k.kind === "CronJob" ? "Suspended" : PROBLEMS_STATUS,
    }))
    .sort((a, b) => b.count - a.count);
}
