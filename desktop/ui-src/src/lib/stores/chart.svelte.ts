// The chart (every kind of the cluster, where the sidebar used to be) and
// the wake (lib/trail.ts). The chart is summoned and goes away once a view
// is chosen; pinned, it stays as a column beside the sheet.

import { untrack } from "svelte";
import { pushTrail, type Step, type Tick } from "../trail";

const PIN_KEY = "nauvi.chart.pinned";

function readPinned(): boolean {
  try {
    return localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}

export const chart = $state({
  pinned: readPinned(),
  open: false,
  /** What is typed into the summoned chart: it narrows the kinds. */
  lens: "",
  trail: [] as Step[],
  /** The object panel takes the whole sheet; the table folds into its spine. */
  wide: false,
});

export function toggleChart() {
  if (!chart.pinned) chart.open = !chart.open;
}

export function closeChart() {
  chart.open = false;
  chart.lens = "";
}

/**
 * A view's rows as ticks on its spine, as last seen (the table on screen
 * keeps its own current). Not deep state: replaced per view.
 */
let ticksByView = $state.raw<Record<string, Tick[]>>({});
export const spineTicks = {
  get byView() {
    return ticksByView;
  },
  set byView(v: Record<string, Tick[]>) {
    ticksByView = v;
  },
};

export function reportTicks(view: string, ticks: Tick[]) {
  // Untracked: the effect that reports must not depend on what it writes.
  ticksByView = { ...untrack(() => ticksByView), [view]: ticks };
}

export function setChartPinned(pinned: boolean) {
  chart.pinned = pinned;
  closeChart();
  try {
    localStorage.setItem(PIN_KEY, pinned ? "1" : "0");
  } catch {
    // Not remembered: pinned for this session only.
  }
}

/** The view on screen changed: it joins the wake and the chart goes away. */
export function visitView(view: string) {
  chart.trail = pushTrail(chart.trail, { view });
  closeChart();
}

/** An object was opened: its own spine, after its view's. */
export function visitObject(view: string, namespace: string, name: string) {
  chart.trail = pushTrail(chart.trail, { view, object: { namespace, name } });
}

/** A context switch: the wake was of another cluster. */
export function clearTrail() {
  chart.trail = [];
  chart.wide = false;
  spineTicks.byView = {};
}
