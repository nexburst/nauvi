// The CSV export of the table on screen (#221). The resource table registers
// what it shows while mounted; the toolbar's Export button asks for it.

import type { ResourceKind } from "../bindings";

/** What the table on screen shows: its kind and its rows as CSV. */
export interface TableExport {
  kind: ResourceKind;
  /** Number of rows shown (filtered), without the header. */
  rows(): number;
  /** The shown rows and columns, in the shown order, as CSV text. */
  csv(): string;
}

class Current {
  current = $state.raw<TableExport | null>(null);
}
const state = new Current();

/** Register the table on screen; returns the unregister function. */
export function registerTableExport(handle: TableExport): () => void {
  state.current = handle;
  return () => {
    if (state.current === handle) state.current = null;
  };
}

/** The table on screen, if it is a resource table. */
export function tableExport(): TableExport | null {
  return state.current;
}
