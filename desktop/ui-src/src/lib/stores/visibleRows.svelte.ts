// The rows a table shows: filtered and sorted from the store (#380). The
// clock (`now`) is read untracked: no column sorts or filters by it (Age sorts
// by `created`), so an age tick redraws the Age cells only, not the 5k-row
// filter and sort.

import { untrack } from "svelte";
import type { Entry } from "./keyed.svelte";
import type { Column, Metrics, Row } from "../columns";
import { visibleEntries } from "../view";
import type { Sort } from "../view";

export interface VisibleInputs {
  entries: Entry<Row>[];
  match: Parameters<typeof visibleEntries>[1];
  sort: Sort | null;
  columns: Column[];
  metrics: Metrics;
  status: string;
}

/** A derived list of the visible entries; `now` does not re-run it. */
export function visibleRows(inputs: () => VisibleInputs, now: () => number): { readonly value: Entry<Row>[] } {
  const value = $derived.by(() => {
    const i = inputs();
    return visibleEntries(i.entries, i.match, i.sort, i.columns, { metrics: i.metrics, now: untrack(now) }, i.status);
  });
  return {
    get value() {
      return value;
    },
  };
}
