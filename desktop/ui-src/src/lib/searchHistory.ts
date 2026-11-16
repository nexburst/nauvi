// The table filter's recent and starred searches (#219), kept in the
// settings (`searches`) and offered under the filter box in every list.
// Only what the user typed and the two toggles are kept: nothing read from
// the cluster, so no Secret data ever ends up in the settings file.

import type { SavedSearch_Serialize, SearchHistory_Serialize } from "./bindings";

// The backend fills in missing fields, so what it sends always has them all.
export type SavedSearch = SavedSearch_Serialize;
export type SearchHistory = SearchHistory_Serialize;

/** Mirrors `MAX_RECENT`, `MAX_STARRED` and `MAX_SEARCH_LEN` in `settings.rs`. */
export const MAX_RECENT = 10;
export const MAX_STARRED = 50;
export const MAX_SEARCH_LEN = 200;

export const EMPTY_HISTORY: SearchHistory = { recent: [], starred: [] };

/** Same text and the same toggles. */
export function sameSearch(a: SavedSearch, b: SavedSearch): boolean {
  return a.text === b.text && a.regex === b.regex && a.match_case === b.match_case;
}

/** What is kept of a search: plain text without surrounding spaces (the
 *  filter ignores them), a regex as typed. Null when not worth keeping. */
export function keptSearch(s: SavedSearch): SavedSearch | null {
  const text = s.regex ? s.text : s.text.trim();
  if (!text.trim() || [...text].length > MAX_SEARCH_LEN) return null;
  return { text, regex: s.regex, match_case: s.match_case };
}

function clean(list: readonly SavedSearch[], max: number): SavedSearch[] {
  const out: SavedSearch[] = [];
  for (const s of list) {
    if (!s || typeof s.text !== "string") continue;
    if (!s.text.trim() || [...s.text].length > MAX_SEARCH_LEN) continue;
    const item = { text: s.text, regex: !!s.regex, match_case: !!s.match_case };
    if (!out.some((o) => sameSearch(o, item))) out.push(item);
  }
  return out.slice(0, max);
}

/** Drop empty, too long and repeated entries and cap both lists (as the backend does). */
export function normalizeHistory(h: SearchHistory | null | undefined): SearchHistory {
  return { recent: clean(h?.recent ?? [], MAX_RECENT), starred: clean(h?.starred ?? [], MAX_STARRED) };
}

/** `h` with `s` as the newest recent search; unchanged (the same object) if not worth keeping or already newest. */
export function remember(h: SearchHistory, s: SavedSearch): SearchHistory {
  const kept = keptSearch(s);
  if (!kept) return h;
  if (h.recent[0] && sameSearch(h.recent[0], kept)) return h;
  const recent = [kept, ...h.recent.filter((r) => !sameSearch(r, kept))].slice(0, MAX_RECENT);
  return { ...h, recent };
}

export function isStarred(h: SearchHistory, s: SavedSearch): boolean {
  const kept = keptSearch(s);
  return kept !== null && h.starred.some((x) => sameSearch(x, kept));
}

/** Star `s` (at the end) or unstar it. */
export function toggleStar(h: SearchHistory, s: SavedSearch): SearchHistory {
  const kept = keptSearch(s);
  if (!kept) return h;
  if (h.starred.some((x) => sameSearch(x, kept))) {
    return { ...h, starred: h.starred.filter((x) => !sameSearch(x, kept)) };
  }
  if (h.starred.length >= MAX_STARRED) return h;
  return { ...h, starred: [...h.starred, kept] };
}

/** `h` without `s` among the recent searches (a starred one stays starred). */
export function forget(h: SearchHistory, s: SavedSearch): SearchHistory {
  return { ...h, recent: h.recent.filter((r) => !sameSearch(r, s)) };
}

export interface Suggestion {
  search: SavedSearch;
  starred: boolean;
}

/**
 * What to offer under the filter box while it holds `text`: starred first,
 * then recent ones that are not starred, each containing `text` (ignoring
 * case; all of them for an empty box). The search already in the box
 * (same text and toggles) is left out.
 */
export function suggestions(h: SearchHistory, text: string, current?: SavedSearch): Suggestion[] {
  const q = text.trim().toLowerCase();
  const fits = (s: SavedSearch) => (!q || s.text.toLowerCase().includes(q)) && !(current && sameSearch(s, current));
  const starred = h.starred.filter(fits).map((search) => ({ search, starred: true }));
  const recent = h.recent
    .filter((r) => fits(r) && !h.starred.some((x) => sameSearch(x, r)))
    .map((search) => ({ search, starred: false }));
  return [...starred, ...recent];
}

/** How a search is shown in the list: `/regex/` and an "Aa" mark. */
export function searchLabel(s: SavedSearch): string {
  return s.regex ? `/${s.text}/` : s.text;
}
