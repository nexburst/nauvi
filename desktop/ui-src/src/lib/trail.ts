/**
 * The wake: the views you have been to, as thin live spines beside the
 * sheet. A view keeps its place when you come back to it (so the spines
 * don't shuffle under the pointer); a new one is added at the end and the
 * oldest falls off.
 */

import { APPLICATIONS_VIEW } from "./applications";
import { CATALOG_VIEW } from "./catalog";
import { PORT_FORWARDS_VIEW } from "./forwards";
import { HELM_VIEW } from "./helm";
import { HELM_CHARTS_VIEW } from "./helmCharts";
import { WORKLOADS_VIEW } from "./workloads";

/** How many spines the wake keeps. */
export const TRAIL_MAX = 7;

/** One spine: a view, or an object opened in it ("crashed" after "Pods"). */
export interface Step {
  view: string;
  /** Set for an object's spine. */
  object?: { namespace: string; name: string };
}

export function stepId(s: Step): string {
  return s.object ? `${s.view}|${s.object.namespace}/${s.object.name}` : s.view;
}

/**
 * The trail with `step` on it. A view's first object goes right after the
 * view, so the wake reads as a path (Overview, Pods, crashed).
 */
export function pushTrail(trail: readonly Step[], step: Step, max = TRAIL_MAX): Step[] {
  const id = stepId(step);
  if (!step.view || trail.some((s) => stepId(s) === id)) return [...trail];
  const next = [...trail];
  if (step.object) {
    // After the view's spine and the objects already opened from it.
    let at = next.findIndex((s) => s.view === step.view && !s.object);
    if (at < 0) at = next.length - 1;
    while (at + 1 < next.length && next[at + 1].view === step.view && next[at + 1].object) at++;
    next.splice(at + 1, 0, step);
  } else {
    next.push(step);
  }
  // The oldest falls off, but never the step just added.
  while (next.length > max) next.splice(next[0] === step ? 1 : 0, 1);
  return next;
}

/** How a row reads on a spine: a tick of its tone. */
export type Tone = "ok" | "warn" | "bad";

export interface Tick {
  namespace: string;
  name: string;
  tone: Tone;
}

/** How many ticks a spine draws; beyond it the strip would be noise. */
export const TICKS_MAX = 120;

const WARN = /^(Pending|Terminating|ContainerCreating|Released|Warning|Progressing|Updating)/;

/** The ticks of a table, in its order: what needs attention is coral. */
export function ticksOf(
  rows: readonly { namespace: string; name: string; problem: string; status: string; cells: readonly string[] }[],
  max = TICKS_MAX,
): Tick[] {
  return rows.slice(0, max).map((r) => ({
    namespace: r.namespace,
    name: r.name,
    tone: r.problem
      ? WARN.test(r.problem) || WARN.test(r.status)
        ? "warn"
        : "bad"
      : r.cells.some((c) => WARN.test(c))
        ? "warn"
        : "ok",
  }));
}

const VIEW_LABELS: Record<string, string> = {
  overview: "Overview",
  [WORKLOADS_VIEW]: "Workloads",
  [APPLICATIONS_VIEW]: "Applications",
  [HELM_VIEW]: "Releases",
  [HELM_CHARTS_VIEW]: "Charts",
  [PORT_FORWARDS_VIEW]: "Port Forwards",
  [CATALOG_VIEW]: "Catalog",
};

/** What a spine says: the kind's label, or the name of a view of its own. */
export function viewLabel(view: string, kinds: readonly { id: string; label: string }[]): string {
  return VIEW_LABELS[view] ?? kinds.find((k) => k.id === view)?.label ?? view;
}
