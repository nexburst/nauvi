// The shell's own state: the berths (lib/berths.ts), the drawer of kinds
// (where the sidebar used to be) and the inspector's width. The drawer is
// summoned and goes away once a view is chosen; pinned, it stays as a
// column beside the sheet.

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

export const chart = $state({
  pinned: read(PIN_KEY) === "1",
  open: false,
  /** What is typed into the summoned drawer: it narrows the kinds. */
  lens: "",
  /** The views kept at hand, in the user's order. */
  berths: parseBerths(read(BERTHS_KEY)),
  /** Bumped when a berth is refused because the column is full. */
  fullNonce: 0,
  /** The object panel takes the whole sheet; the table waits behind it. */
  wide: false,
  /** Why the open object needs attention, as its row says ("": it is fine). */
  verdict: "",
});

export function toggleChart() {
  if (!chart.pinned) chart.open = !chart.open;
}

export function closeChart() {
  chart.open = false;
  chart.lens = "";
}

export function setChartPinned(pinned: boolean) {
  chart.pinned = pinned;
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
