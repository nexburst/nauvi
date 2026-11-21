// The table filter's toggles, its search history and the matching of a
// regex (#219). The text itself is `app.search`, shared by every list.

import { untrack } from "svelte";
import { app } from "./app.svelte";
import { settings, updateSettings } from "./settings.svelte";
import { compileFilter, filterKey, nameMatches, NO_FILTER } from "../tableFilter";
import type { CompiledFilter } from "../tableFilter";
import { LogSearcher } from "../logSearch";
import { EMPTY_HISTORY, forget, normalizeHistory, remember, toggleStar } from "../searchHistory";
import type { SavedSearch, SearchHistory } from "../searchHistory";

export const tableFilter = $state({
  matchCase: false,
  regex: false,
  /** The last regex took too long ("" when not). */
  slow: "",
});

let memo: { key: string; compiled: CompiledFilter } = { key: "", compiled: NO_FILTER };
let lastGood: CompiledFilter = NO_FILTER;

/** What is in the box with the toggles, checked (an invalid regex is an `error`). */
export function compiledFilter(): CompiledFilter {
  const { matchCase, regex } = tableFilter;
  const text = app.search;
  const key = `${matchCase ? 1 : 0}${regex ? 1 : 0}${text}`;
  if (memo.key !== key) memo = { key, compiled: compileFilter({ text, regex, matchCase }) };
  return memo.compiled;
}

/** The filter the lists use: while the regex is invalid, the last good one. */
export function activeFilter(): CompiledFilter {
  const c = compiledFilter();
  if (c.kind === "error") return lastGood;
  lastGood = c;
  return c;
}

/** Shown under the box: an invalid or too slow regex ("" when fine). */
export function filterError(): string {
  const c = compiledFilter();
  if (c.kind === "error") return `Invalid regex: ${c.message}`;
  return c.kind === "regex" ? tableFilter.slow : "";
}

/** Keep the filter when opening `name` from elsewhere only if its row would show. */
export function filterKeeps(name: string): boolean {
  return nameMatches(activeFilter(), name) === true;
}

// ---- History ----

export function searchHistory(): SearchHistory {
  return settings.current.searches ?? EMPTY_HISTORY;
}

/** The search in the box now. */
export function currentSearch(): SavedSearch {
  return { text: app.search, regex: tableFilter.regex, match_case: tableFilter.matchCase };
}

function saveHistory(next: SearchHistory) {
  if (next !== searchHistory()) void updateSettings({ searches: normalizeHistory(next) });
}

/** Add the search in the box to the recent ones (not an invalid regex). */
export function rememberSearch() {
  if (compiledFilter().kind === "error") return;
  saveHistory(remember(searchHistory(), currentSearch()));
}

export function starSearch(s: SavedSearch) {
  saveHistory(toggleStar(searchHistory(), s));
}

export function forgetSearch(s: SavedSearch) {
  saveHistory(forget(searchHistory(), s));
}

/** Put `s` in the box, with its toggles. */
export function useSearch(s: SavedSearch) {
  tableFilter.regex = s.regex;
  tableFilter.matchCase = s.match_case;
  app.search = s.text;
}

// ---- Regex matching ----

/** One worker for every list: only one list is on screen at a time. */
const searcher = new LogSearcher();
/** The list whose search the worker runs now. */
let owner: object | null = null;

export interface ListFilterOptions<T> {
  /** Unique per item. */
  key: (t: T) => string;
  /** What plain text matches, ignoring case (lower-case). */
  lower: (t: T) => string;
  /** What match case matches: the same text as typed. */
  text: (t: T) => string;
  /** What a regex matches: one field per line (`rawHay`). Default: `text`. */
  lines?: (t: T) => string;
}

/**
 * The filter of one list. Plain text matches at once; a regex runs in the
 * worker each time the items or the query change, and until it answers the
 * list keeps the keys the previous run matched. Create it while a component
 * initialises (it starts an effect).
 */
export class ListFilter<T> {
  #matched = $state.raw<Set<string> | null>(null);
  #runningKey = "";
  /** A regex that took too long; not run again on the next row change. */
  #slowKey = "";
  /** Bumped by each run; an answer for an older one is dropped. */
  #gen = 0;

  constructor(
    items: () => readonly T[],
    private opts: ListFilterOptions<T>,
  ) {
    $effect(() => {
      const f = activeFilter();
      const list = items();
      untrack(() => this.#run(f, list));
    });
    $effect(() => () => {
      this.#gen++;
      if (owner === this) {
        owner = null;
        searcher.cancel();
      }
    });
  }

  async #run(f: CompiledFilter, list: readonly T[]) {
    if (f.kind !== "regex") {
      this.#runningKey = "";
      this.#matched = null;
      tableFilter.slow = "";
      return;
    }
    const key = filterKey(f);
    if (key === this.#slowKey) return;
    // A new query stops a search still running (perhaps a slow one).
    if (key !== this.#runningKey || owner !== this) searcher.cancel();
    this.#runningKey = key;
    owner = this;
    const g = ++this.#gen;
    const lines = this.opts.lines ?? this.opts.text;
    try {
      const hits = await searcher.run(
        f,
        list.map((t) => lines(t)),
        () => g !== this.#gen,
        true,
      );
      if (hits === null || g !== this.#gen) return;
      const matched = new Set<string>();
      list.forEach((t, i) => {
        if (hits[i] !== null) matched.add(this.opts.key(t));
      });
      this.#matched = matched;
      tableFilter.slow = "";
      this.#slowKey = "";
    } catch (e) {
      if (g !== this.#gen) return;
      this.#slowKey = key;
      tableFilter.slow = e instanceof Error ? e.message : String(e);
    }
  }

  /** Whether an item passes; null when nothing is filtered. */
  get match(): ((t: T) => boolean) | null {
    const f = activeFilter();
    const { key, lower, text } = this.opts;
    if (f.kind === "none" || f.kind === "error") return null;
    if (f.kind === "text") {
      const needle = f.needle;
      const want = !f.negate;
      return f.matchCase ? (t) => text(t).includes(needle) === want : (t) => lower(t).includes(needle) === want;
    }
    const m = this.#matched;
    return m ? (t) => m.has(key(t)) : () => false;
  }
}
