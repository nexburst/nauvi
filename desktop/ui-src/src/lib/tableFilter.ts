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
  /** `needle` is lower-case unless `matchCase`. */
  | { kind: "text"; needle: string; matchCase: boolean }
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
    const t = q.text.trim();
    if (!t) return NO_FILTER;
    return { kind: "text", needle: q.matchCase ? t : t.toLowerCase(), matchCase: q.matchCase };
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
      return `t/${f.matchCase ? "c" : ""}/${f.needle}`;
    case "regex":
      return `r/${f.flags}/${f.source}`;
    case "error":
      return `e/${f.message}`;
  }
}

const rawCache = new WeakMap<object, string>();

/**
 * Every field of a row as typed, one per line (arrays such as table cells
 * one value per line): what match case and a regex look at. Rows are
 * replaced, never mutated, so the text is cached per row object.
 */
export function rawHay(row: object): string {
  let out = rawCache.get(row);
  if (out !== undefined) return out;
  const parts: string[] = [];
  for (const v of Object.values(row)) {
    if (Array.isArray(v)) for (const x of v) parts.push(String(x));
    else parts.push(String(v));
  }
  out = parts.join("\n");
  rawCache.set(row, out);
  return out;
}

/** Whether `name` (an object opened from elsewhere) passes a plain filter;
 *  null when that cannot be told here (a regex runs only in the worker). */
export function nameMatches(f: CompiledFilter, name: string): boolean | null {
  if (f.kind === "none" || f.kind === "error") return true;
  if (f.kind === "regex") return null;
  return (f.matchCase ? name : name.toLowerCase()).includes(f.needle);
}
