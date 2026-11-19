import { describe, expect, it } from "vitest";
import { compileFilter, filterKey, nameMatches, NO_FILTER, rawHay } from "./tableFilter";
import { LogSearcher } from "./logSearch";

const q = (text: string, regex = false, matchCase = false) => compileFilter({ text, regex, matchCase });

describe("compileFilter (#219)", () => {
  it("keeps the old default: trimmed plain text, ignoring case", () => {
    expect(q("  WEB ")).toEqual({ kind: "text", needle: "web", matchCase: false });
    expect(q("   ")).toEqual(NO_FILTER);
    expect(q("")).toEqual(NO_FILTER);
  });

  it("matches case when asked", () => {
    expect(q(" Web", false, true)).toEqual({ kind: "text", needle: "Web", matchCase: true });
  });

  it("compiles a regex with the m flag, i unless match case", () => {
    expect(q("^web-", true)).toEqual({ kind: "regex", source: "^web-", flags: "im" });
    expect(q("^web-", true, true)).toEqual({ kind: "regex", source: "^web-", flags: "m" });
    expect(q("", true)).toEqual(NO_FILTER);
  });

  it("says why a regex is invalid, without the engine's preamble", () => {
    const f = q("web-(", true);
    expect(f.kind).toBe("error");
    if (f.kind === "error") {
      expect(f.message).not.toMatch(/^Invalid regular expression/);
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  it("keys differ by kind, flags and text", () => {
    const keys = [q("web"), q("web", false, true), q("web", true), q("web", true, true), q("")].map(filterKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("rawHay", () => {
  it("puts every field (and each cell) on its own line, as typed, cached per row", () => {
    const row = { name: "Web-1", namespace: "demo", cells: ["Web-1", "1/1", "Running"], created: 5 };
    const hay = rawHay(row);
    expect(hay).toBe("Web-1\ndemo\nWeb-1\n1/1\nRunning\n5");
    expect(rawHay(row)).toBe(hay);
    // ^ and $ match per field with the m flag.
    expect(/^running$/im.test(hay)).toBe(true);
    expect(/^demo$/m.test(hay)).toBe(true);
    expect(/^Run$/m.test(hay)).toBe(false);
  });
});

describe("nameMatches", () => {
  it("tells plain filters at once and leaves a regex to the worker", () => {
    expect(nameMatches(NO_FILTER, "x")).toBe(true);
    expect(nameMatches(q("WEB"), "web-1")).toBe(true);
    expect(nameMatches(q("WEB", false, true), "web-1")).toBe(false);
    expect(nameMatches(q("db"), "web-1")).toBe(false);
    expect(nameMatches(q("^web", true), "web-1")).toBeNull();
  });
});

describe("the search worker in test mode", () => {
  it("answers [] for a match and null otherwise", async () => {
    // No Worker in Vitest: it runs on this thread.
    const s = new LogSearcher(1000, null);
    const f = q("^web-\\d$", true);
    if (f.kind !== "regex") throw new Error("not a regex");
    expect(await s.run(f, ["demo\nweb-1", "web-12", "WEB-3"], () => false, true)).toEqual([[], null, []]);
  });
});

describe("inverse filter", () => {
  it("keeps the rows that do not contain the text after a leading !", () => {
    const f = compileFilter({ text: "!Completed", regex: false, matchCase: false });
    expect(f).toEqual({ kind: "text", needle: "completed", matchCase: false, negate: true });
    expect(nameMatches(f, "job-completed-1")).toBe(false);
    expect(nameMatches(f, "web-1")).toBe(true);
    // Still typing, or a regex (which has its own negation): no inverse.
    expect(compileFilter({ text: "!", regex: false, matchCase: false })).toEqual(NO_FILTER);
    expect(compileFilter({ text: "!a", regex: true, matchCase: false }).kind).toBe("regex");
    expect(filterKey(f)).not.toBe(filterKey(compileFilter({ text: "Completed", regex: false, matchCase: false })));
  });
});
