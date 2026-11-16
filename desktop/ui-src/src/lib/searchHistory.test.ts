import { describe, expect, it } from "vitest";
import {
  EMPTY_HISTORY,
  forget,
  isStarred,
  keptSearch,
  MAX_RECENT,
  MAX_SEARCH_LEN,
  MAX_STARRED,
  normalizeHistory,
  remember,
  sameSearch,
  searchLabel,
  suggestions,
  toggleStar,
} from "./searchHistory";
import type { SavedSearch, SearchHistory } from "./searchHistory";
import { applyPatch, defaultSettings } from "./settings";

const plain = (text: string, match_case = false): SavedSearch => ({ text, regex: false, match_case });
const re = (text: string, match_case = false): SavedSearch => ({ text, regex: true, match_case });
const texts = (list: SavedSearch[]) => list.map((s) => s.text);

describe("searchHistory (#219)", () => {
  it("tells searches apart by text and both toggles", () => {
    expect(sameSearch(plain("web"), plain("web"))).toBe(true);
    expect(sameSearch(plain("web"), re("web"))).toBe(false);
    expect(sameSearch(plain("web"), plain("web", true))).toBe(false);
    expect(sameSearch(plain("web"), plain("Web"))).toBe(false);
  });

  it("keeps plain text trimmed and a regex as typed, and drops empty or too long ones", () => {
    expect(keptSearch(plain("  web "))).toEqual(plain("web"));
    expect(keptSearch(re("web- "))).toEqual(re("web- "));
    expect(keptSearch(plain("   "))).toBeNull();
    expect(keptSearch(re(" "))).toBeNull();
    expect(keptSearch(plain("x".repeat(MAX_SEARCH_LEN)))).not.toBeNull();
    expect(keptSearch(plain("x".repeat(MAX_SEARCH_LEN + 1)))).toBeNull();
  });

  it("remembers the newest first, without repeats, at most MAX_RECENT", () => {
    let h: SearchHistory = EMPTY_HISTORY;
    h = remember(h, plain("web"));
    h = remember(h, plain("db"));
    h = remember(h, plain(" web "));
    expect(texts(h.recent)).toEqual(["web", "db"]);
    for (let i = 0; i < 20; i++) h = remember(h, plain(`q${i}`));
    expect(h.recent).toHaveLength(MAX_RECENT);
    expect(h.recent[0].text).toBe("q19");
  });

  it("returns the same history when nothing changes (so nothing is saved)", () => {
    const h = remember(EMPTY_HISTORY, plain("web"));
    expect(remember(h, plain("web"))).toBe(h);
    expect(remember(h, plain(""))).toBe(h);
    expect(toggleStar(h, plain(" "))).toBe(h);
  });

  it("stars and unstars, in the order starred, at most MAX_STARRED", () => {
    let h = toggleStar(EMPTY_HISTORY, re("^web-"));
    h = toggleStar(h, plain("db"));
    expect(texts(h.starred)).toEqual(["^web-", "db"]);
    expect(isStarred(h, re("^web-"))).toBe(true);
    expect(isStarred(h, plain("^web-"))).toBe(false);
    h = toggleStar(h, re("^web-"));
    expect(texts(h.starred)).toEqual(["db"]);
    let full: SearchHistory = EMPTY_HISTORY;
    for (let i = 0; i < MAX_STARRED + 5; i++) full = toggleStar(full, plain(`s${i}`));
    expect(full.starred).toHaveLength(MAX_STARRED);
  });

  it("forgets a recent search; a starred one stays starred", () => {
    let h = remember(remember(EMPTY_HISTORY, plain("web")), plain("db"));
    h = toggleStar(h, plain("web"));
    h = forget(h, plain("web"));
    expect(texts(h.recent)).toEqual(["db"]);
    expect(texts(h.starred)).toEqual(["web"]);
  });

  it("suggests starred first, then recent ones not starred, containing the text", () => {
    let h: SearchHistory = EMPTY_HISTORY;
    for (const t of ["web-1", "db", "Web-2", "cache"]) h = remember(h, plain(t));
    h = toggleStar(h, plain("db"));
    h = toggleStar(h, re("^web"));
    const all = suggestions(h, "");
    expect(all.map((s) => [s.search.text, s.starred])).toEqual([
      ["db", true],
      ["^web", true],
      ["cache", false],
      ["Web-2", false],
      ["web-1", false],
    ]);
    expect(suggestions(h, " WEB ").map((s) => s.search.text)).toEqual(["^web", "Web-2", "web-1"]);
    // The search already in the box is not offered again.
    expect(suggestions(h, "web-1", plain("web-1")).map((s) => s.search.text)).toEqual([]);
    expect(suggestions(h, "nothing")).toEqual([]);
  });

  it("normalizes what the settings hold", () => {
    const messy = {
      recent: [plain("a"), plain("a"), plain(""), plain("x".repeat(MAX_SEARCH_LEN + 1)), ...Array(20).fill(plain("b"))],
      starred: [re("c"), null, { text: 3 }],
    } as unknown as SearchHistory;
    expect(normalizeHistory(messy)).toEqual({ recent: [plain("a"), plain("b")], starred: [re("c")] });
    expect(normalizeHistory(undefined)).toEqual(EMPTY_HISTORY);
  });

  it("is applied by a settings patch, which holds only the typed strings and toggles", () => {
    const h = toggleStar(remember(EMPTY_HISTORY, plain("web")), re("^db-", true));
    const next = applyPatch(defaultSettings(), { searches: h });
    expect(next.searches).toEqual({ recent: [plain("web")], starred: [re("^db-", true)] });
    // Nothing but these three fields per entry.
    for (const s of [...next.searches.recent, ...next.searches.starred]) {
      expect(Object.keys(s).sort()).toEqual(["match_case", "regex", "text"]);
    }
  });

  it("labels a regex with slashes", () => {
    expect(searchLabel(plain("web"))).toBe("web");
    expect(searchLabel(re("^web"))).toBe("/^web/");
  });
});
