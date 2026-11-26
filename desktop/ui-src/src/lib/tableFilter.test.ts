import { describe, expect, it } from "vitest";
import { compileFilter, cutHit, filterKey, nameMatches, NO_FILTER, shownText } from "./tableFilter";
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

describe("shownText", () => {
  // A pod as the backend sends it: Name, Namespace, Ready, Status, then the
  // off-by-default QoS column (#512: "burst" matched its "Burstable").
  const pod = () => ({ name: "Web-1", namespace: "demo", cells: ["Web-1", "demo", "1/1", "Running", "Burstable"], created: 5 });

  it("has the name, the namespace and the shown cells, one per line, as typed", () => {
    const row = pod();
    const t = shownText([0, 1, 2, 3]);
    expect(t.raw(row)).toBe("Web-1\ndemo\nWeb-1\ndemo\n1/1\nRunning");
    expect(t.lower(row)).toBe("web-1\ndemo\nweb-1\ndemo\n1/1\nrunning");
    // ^ and $ match per field with the m flag.
    expect(/^running$/im.test(t.raw(row))).toBe(true);
    expect(/^Run$/m.test(t.raw(row))).toBe(false);
  });

  it("leaves out a column that is not shown, the creation time and the key", () => {
    const row = pod();
    const hidden = shownText([0, 1, 2, 3]);
    expect(hidden.lower(row)).not.toContain("burst");
    expect(hidden.raw(row)).not.toContain("5");
    // Turned on in the column chooser, it matches.
    expect(shownText([0, 1, 2, 3, 4]).lower(row)).toContain("burst");
  });

  it("is cached per row and per set of columns", () => {
    const row = pod();
    const a = shownText([0, 2]);
    expect(a.raw(row)).toBe(a.raw(row));
    expect(shownText([0, 4]).raw(row)).toBe("Web-1\ndemo\nWeb-1\nBurstable");
    expect(shownText([0, 2]).raw(row)).toBe("Web-1\ndemo\nWeb-1\n1/1");
  });

  it("skips empty and missing cells", () => {
    const row = { name: "n", namespace: "", cells: ["n", ""] };
    expect(shownText([0, 1, 7]).raw(row)).toBe("n\n\nn");
  });
});

describe("cutHit", () => {
  const full = "redis-cache-7d9f8b6c5-burst-x2k4p";

  it("is true when a plain filter matches only the part a cut cell hides", () => {
    expect(cutHit(q("burst"), full, "redis-c…x2k4p")).toBe(true);
    expect(cutHit(q("BURST"), full, "redis-c…x2k4p")).toBe(true);
  });

  it("is false when the shown part has it, nothing matches, or the filter is not plain text", () => {
    expect(cutHit(q("redis"), full, "redis-c…x2k4p")).toBe(false);
    expect(cutHit(q("nginx"), full, "redis-c…x2k4p")).toBe(false);
    expect(cutHit(q("BURST", false, true), full, "redis-c…x2k4p")).toBe(false);
    expect(cutHit(q("!burst"), full, "redis-c…x2k4p")).toBe(false);
    expect(cutHit(q("burst", true), full, "redis-c…x2k4p")).toBe(false);
    expect(cutHit(NO_FILTER, full, "redis-c…x2k4p")).toBe(false);
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
