// Search in a terminal's scrollback (#222), with xterm's search addon.

import type { ISearchOptions } from "@xterm/addon-search";

/** At most this many matches are highlighted (and counted exactly). */
export const HIGHLIGHT_LIMIT = 1000;

/** The highlights, on the terminal's own dark background (#RRGGBB only). */
const DECORATIONS = {
  matchBackground: "#6b5400",
  matchOverviewRuler: "#f5a524",
  activeMatchBackground: "#d18616",
  activeMatchBorder: "#ffd27a",
  activeMatchColorOverviewRuler: "#ffd27a",
} as const;

export function searchOptions(caseSensitive: boolean, incremental = false): ISearchOptions {
  return { caseSensitive, incremental, decorations: { ...DECORATIONS } };
}

/**
 * What the search bar says: "3 of 12", "No matches", or "1000+ matches"
 * when there are more than the addon highlights (it then gives no index).
 */
export function matchLabel(query: string, index: number, count: number): string {
  if (!query) return "";
  if (count === 0) return "No matches";
  if (index < 0) return count >= HIGHLIGHT_LIMIT ? `${HIGHLIGHT_LIMIT}+ matches` : `${count} matches`;
  return `${index + 1} of ${count}`;
}

/** The terminal's selection as a starting query: one line of text, or nothing. */
export function initialQuery(selection: string): string {
  const s = selection.trim();
  return s && !s.includes("\n") && s.length <= 200 ? s : "";
}
