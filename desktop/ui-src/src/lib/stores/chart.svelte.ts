// The shell's own state: the berths (lib/berths.ts), the drawer of kinds
// (where the sidebar used to be) and the inspector's width. The drawer is
// summoned and goes away once a view is chosen; pinned, it stays as a
// column beside the sheet (the sidebar, expanded); not pinned, the berths
// are the sidebar collapsed to a rail of icons.

import { parseBerths, pinBerth, unpinBerth } from "../berths";

const PIN_KEY = "nauvi.chart.pinned";
const BERTHS_KEY = "nauvi.berths";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered: for this session only.
  }
}

/**
 * Whether the kinds start as a column (#490): as last chosen, and on a first
 * launch when the window is wide enough to keep them beside the sheet (a
 * 1280-px window, less what a window frame may take). Narrower, they start
 * as the rail of icons.
 */
export function pinnedAtStart(stored: string | null, width: number): boolean {
  if (stored === "1" || stored === "0") return stored === "1";
  return width >= FIRST_LAUNCH_WIDTH;
}
export const FIRST_LAUNCH_WIDTH = 1200;

function windowWidth(): number {
  try {
    return window.innerWidth;
  } catch {
    return 0;
  }
}

export const chart = $state({
  pinned: pinnedAtStart(read(PIN_KEY), windowWidth()),
  open: false,
  /** What is typed into the drawer or the column's filter: it narrows the kinds. */
  lens: "",
  /** Bumped by G while the kinds are a column: the filter takes the keyboard. */
  focusNonce: 0,
  /** The views kept at hand, in the user's order. */
  berths: parseBerths(read(BERTHS_KEY)),
  /** Bumped when a berth is refused because the column is full. */
  fullNonce: 0,
  /** The object panel takes the whole sheet; the table waits behind it. */
  wide: false,
  /** Why the open object needs attention, as its row says ("": it is fine). */
  verdict: "",
});

/** G: summon (or send away) the drawer; with the kinds as a column, go to its filter. */
export function toggleChart() {
  if (chart.pinned) chart.focusNonce++;
  else chart.open = !chart.open;
}

/** Send the drawer away. The column's filter stays until it is cleared. */
export function closeChart() {
  chart.open = false;
  if (!chart.pinned) chart.lens = "";
}

export function setChartPinned(pinned: boolean) {
  chart.pinned = pinned;
  chart.lens = "";
  closeChart();
  write(PIN_KEY, pinned ? "1" : "0");
}

/** Keep `view` in a berth, or let it go if it has one. */
export function toggleBerth(view: string) {
  if (chart.berths.includes(view)) {
    chart.berths = unpinBerth(chart.berths, view);
  } else {
    const next = pinBerth(chart.berths, view);
    if (next.full) chart.fullNonce++;
    chart.berths = next.berths;
  }
  write(BERTHS_KEY, JSON.stringify(chart.berths));
}
