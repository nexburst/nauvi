import type { Column, Ctx, Row } from "./columns";
import type { Entry } from "./stores/keyed.svelte";
import { matchesStatus } from "./workloads";

export interface Sort {
  key: string;
  dir: "asc" | "desc";
}

const cmp = <V extends string | number>(a: V, b: V): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Filter by the search text and the status filter (`status`, a
 * `ResourceRow.status`; `""` = any), and sort. Without an explicit sort rows are in
 * key order (`namespace/name`), as in the old UI.
 */
export function visibleEntries(
  entries: Entry<Row>[],
  search: string | ((e: Entry<Row>) => boolean) | null,
  sort: Sort | null,
  columns: Column[],
  ctx: Ctx,
  status = "",
): Entry<Row>[] {
  // A string: plain text ignoring case; a function: the table filter's
  // match (`ListFilter`, #219); null: no filter.
  const q = typeof search === "string" ? search.trim().toLowerCase() : "";
  const match = typeof search === "function" ? search : q ? (e: Entry<Row>) => e.hay.includes(q) : null;
  const filtered =
    match || status
      ? entries.filter((e) => matchesStatus(e.row, status) && (!match || match(e)))
      : entries.slice();
  const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
  if (!col || !sort) {
    return filtered.sort((a, b) => cmp(a.key, b.key));
  }
  // Decorate once so the comparator does not recompute cells.
  const values = new Map<Entry<Row>, string | number>();
  for (const e of filtered) values.set(e, col.sort(e.row, ctx));
  const dir = sort.dir === "asc" ? 1 : -1;
  return filtered.sort((a, b) => {
    const c = cmp(values.get(a)!, values.get(b)!);
    return c !== 0 ? c * dir : cmp(a.key, b.key);
  });
}
