// The table filter (#219): plain text (the default, as before: trimmed and
// ignoring case), match case, or a regex. Pure functions; a regex runs in
// the search worker (logSearch.ts) with a time limit, never on the UI
// thread, because a list can have thousands of rows.

import { invalidRegexMessage } from "./logFilter";

/** What is in the filter box, and the two toggles. */
export interface FilterQuery {
  text: string;
  regex: boolean;
  matchCase: boolean;
}

export type CompiledFilter =
  | { kind: "none" }
  /** `needle` is lower-case unless `matchCase`. `negate`: keep what does NOT match. */
  | { kind: "text"; needle: string; matchCase: boolean; negate?: boolean }
  | { kind: "regex"; source: string; flags: string }
  | { kind: "error"; message: string };

export const NO_FILTER: CompiledFilter = { kind: "none" };

/**
 * Check a query. A regex gets the `m` flag: each field of a row is on its
 * own line of the text it is matched against, so `^web` and `-db$` match
 * at the start and end of any field (a name, a namespace, a cell).
 */
export function compileFilter(q: FilterQuery): CompiledFilter {
  if (!q.regex) {
    const typed = q.text.trim();
    // "!completed" (as in k9s): the rows that do not contain it. A lone "!"
    // is still being typed.
    const negate = typed.startsWith("!") && typed.length > 1;
    const t = negate ? typed.slice(1).trim() : typed;
    if (!t || typed === "!") return NO_FILTER;
    return {
      kind: "text",
      needle: q.matchCase ? t : t.toLowerCase(),
      matchCase: q.matchCase,
      ...(negate ? { negate } : {}),
    };
  }
  if (!q.text) return NO_FILTER;
  const flags = q.matchCase ? "m" : "im";
  try {
    new RegExp(q.text, flags);
  } catch (e) {
    return { kind: "error", message: invalidRegexMessage(e) };
  }
  return { kind: "regex", source: q.text, flags };
}

/** Identifies a compiled query (for caching the matches of a regex). */
export function filterKey(f: CompiledFilter): string {
  switch (f.kind) {
    case "none":
      return "";
    case "text":
      return `t/${f.matchCase ? "c" : ""}${f.negate ? "!" : ""}/${f.needle}`;
    case "regex":
      return `r/${f.flags}/${f.source}`;
    case "error":
      return `e/${f.message}`;
  }
}

/** Whether `name` (an object opened from elsewhere) passes a plain filter;
 *  null when that cannot be told here (a regex runs only in the worker). */
export function nameMatches(f: CompiledFilter, name: string): boolean | null {
  if (f.kind === "none" || f.kind === "error") return true;
  if (f.kind === "regex") return null;
  return (
    (f.matchCase ? name : name.toLowerCase()).includes(f.needle) !== !!f.negate
  );
}

/** What a resource table row is matched on (#512). */
export interface TableRowLike {
  name: string;
  namespace: string;
  cells: readonly string[];
}

/** What the table filter matches in a resource table row, given which cells are shown. */
export interface ShownText {
  /** The row's name, namespace and shown cells as typed, one per line
   *  (match case, and a regex in the worker). */
  raw(row: TableRowLike): string;
  /** The same, lower-cased (plain text). */
  lower(row: TableRowLike): string;
}

const shownCache = new WeakMap<
  object,
  { sig: string; raw: string; lower: string }
>();

/**
 * The text a resource table's filter matches (#512): what the row shows.
 * That is its name and namespace and the cells of the shown columns
 * (`cells`: indexes into `row.cells`), never an off-by-default column the
 * user has not turned on (QoS "Burstable" used to match "burst") nor the
 * creation time or the row's key. A cell cut in the middle (#482) still
 * matches on its whole value; `cutHit` tells the table to mark it.
 */
export function shownText(cells: readonly number[]): ShownText {
  const sig = cells.join(",");
  const entry = (row: TableRowLike) => {
    const hit = shownCache.get(row);
    if (hit && hit.sig === sig) return hit;
    const parts = [row.name, row.namespace];
    for (const i of cells) {
      const c = row.cells[i];
      if (c) parts.push(c);
    }
    const raw = parts.join("\n");
    const out = { sig, raw, lower: raw.toLowerCase() };
    shownCache.set(row, out);
    return out;
  };
  return { raw: (r) => entry(r).raw, lower: (r) => entry(r).lower };
}

/** Indexes into `row.cells` of the `shown` columns, in the kind's column
 *  definitions `defs` (columns the UI fills itself have empty cells). */
export function shownCells(defs: readonly { key: string }[], shown: readonly { key: string }[]): number[] {
  return shown.map((c) => defs.findIndex((d) => d.key === c.key)).filter((i) => i >= 0);
}

/**
 * Whether a cell cut in the middle (#482) matches a plain filter only in
 * the part it does not show: the table marks it, so the row shows why it is
 * listed. `shown` is what the cell shows (with its "…"). A regex, or a
 * filter that keeps what does not match, marks nothing.
 */
export function cutHit(
  f: CompiledFilter,
  full: string,
  shown: string,
): boolean {
  if (f.kind !== "text" || f.negate) return false;
  const fold = (s: string) => (f.matchCase ? s : s.toLowerCase());
  return fold(full).includes(f.needle) && !fold(shown).includes(f.needle);
}
