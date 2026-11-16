import { describe, expect, it } from "vitest";
import { HIGHLIGHT_LIMIT, initialQuery, matchLabel, searchOptions } from "./terminalSearch";

describe("matchLabel", () => {
  it("says nothing without a query", () => {
    expect(matchLabel("", -1, 0)).toBe("");
  });
  it("counts the matches and names the active one", () => {
    expect(matchLabel("x", -1, 0)).toBe("No matches");
    expect(matchLabel("x", 0, 1)).toBe("1 of 1");
    expect(matchLabel("x", 2, 12)).toBe("3 of 12");
  });
  it("says when there are more than it highlights", () => {
    expect(matchLabel("x", -1, HIGHLIGHT_LIMIT)).toBe("1000+ matches");
    expect(matchLabel("x", -1, 5)).toBe("5 matches");
  });
});

describe("initialQuery", () => {
  it("takes a one-line selection", () => {
    expect(initialQuery("  nginx ")).toBe("nginx");
  });
  it("ignores empty, multi-line and very long selections", () => {
    expect(initialQuery("")).toBe("");
    expect(initialQuery("a\nb")).toBe("");
    expect(initialQuery("x".repeat(201))).toBe("");
  });
});

describe("searchOptions", () => {
  it("always asks for highlights, in #RRGGBB", () => {
    const o = searchOptions(true, true);
    expect(o.caseSensitive).toBe(true);
    expect(o.incremental).toBe(true);
    expect(o.decorations?.matchBackground).toMatch(/^#[0-9a-f]{6}$/);
    expect(o.decorations?.activeMatchBackground).toMatch(/^#[0-9a-f]{6}$/);
  });
});
