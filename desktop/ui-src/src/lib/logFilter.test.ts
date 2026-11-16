import { describe, expect, it } from "vitest";
import {
  compileQuery,
  invalidRegexMessage,
  findTime,
  indexOfId,
  lineTime,
  matchCountLabel,
  MAX_HITS_PER_LINE,
  parseJumpTime,
  regexRanges,
  segments,
  stepMatch,
  textRanges,
} from "./logFilter";

const q = (text: string, regex = false, matchCase = false) => compileQuery({ text, regex, matchCase });

describe("compileQuery", () => {
  it("is off for an empty box", () => {
    expect(q("")).toEqual({ kind: "none" });
    expect(q("", true)).toEqual({ kind: "none" });
  });

  it("matches text case-insensitively by default, as before", () => {
    expect(q("Error")).toEqual({ kind: "text", needle: "error", matchCase: false });
    expect(q("Error", false, true)).toEqual({ kind: "text", needle: "Error", matchCase: true });
  });

  it("compiles a regex with or without the i flag", () => {
    expect(q("a+b", true)).toEqual({ kind: "regex", source: "a+b", flags: "gi" });
    expect(q("a+b", true, true)).toEqual({ kind: "regex", source: "a+b", flags: "g" });
  });

  it("says why a regex is invalid, without the engine's preamble", () => {
    const r = q("(a", true);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).not.toMatch(/^Invalid regular expression/);
      expect(r.message.length).toBeGreaterThan(0);
    }
    expect(invalidRegexMessage(new SyntaxError("Invalid regular expression: /(a/gi: Unterminated group"))).toBe(
      "Unterminated group",
    );
    expect(invalidRegexMessage(new SyntaxError("Invalid regular expression: missing )"))).toBe("missing )");
    // Plain text never fails.
    expect(q("(a").kind).toBe("text");
  });
});

describe("textRanges", () => {
  it("finds every occurrence, case-insensitively unless asked", () => {
    expect(textRanges("Error: error", "error", false)).toEqual([0, 5, 7, 12]);
    expect(textRanges("Error: error", "error", true)).toEqual([7, 12]);
    expect(textRanges("all good", "error", false)).toBeNull();
  });

  it("does not overlap and stops at the cap", () => {
    expect(textRanges("aaaa", "aa", true)).toEqual([0, 2, 2, 4]);
    const many = textRanges("x".repeat(1000), "x", true);
    expect(many).toHaveLength(MAX_HITS_PER_LINE * 2);
  });
});

describe("regexRanges", () => {
  const re = (s: string, f = "gi") => new RegExp(s, f);

  it("returns each match's range", () => {
    expect(regexRanges(re("\\d+"), "GET /a 200 in 35ms")).toEqual([7, 10, 14, 16]);
    expect(regexRanges(re("5\\d\\d"), "GET /a 200")).toBeNull();
  });

  it("follows the case flag", () => {
    expect(regexRanges(re("error", "g"), "ERROR error")).toEqual([6, 11]);
    expect(regexRanges(re("error", "gi"), "ERROR error")).toEqual([0, 5, 6, 11]);
  });

  it("matches a line on an empty match (like grep) without looping", () => {
    expect(regexRanges(re("^"), "anything")).toEqual([]);
    expect(regexRanges(re("x*"), "abc")).toEqual([]);
    expect(regexRanges(re("x*"), "axxb")).toEqual([1, 3]);
    expect(regexRanges(re("$"), "")).toEqual([]);
    // An astral character with the u flag: steps over both halves.
    expect(regexRanges(new RegExp("", "gu"), "😀a")).toEqual([]);
  });

  it("can be reused: lastIndex is reset", () => {
    const r = re("a");
    expect(regexRanges(r, "aa")).toEqual([0, 1, 1, 2]);
    expect(regexRanges(r, "ba")).toEqual([1, 2]);
  });

  it("stops at the cap", () => {
    expect(regexRanges(re("."), "y".repeat(1000))).toHaveLength(MAX_HITS_PER_LINE * 2);
  });
});

describe("segments", () => {
  it("is the whole text without ranges", () => {
    expect(segments("abc", null)).toEqual([{ text: "abc", hit: false }]);
    expect(segments("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });

  it("splits at the ranges, keeping all the text", () => {
    expect(segments("Error: error", [0, 5, 7, 12])).toEqual([
      { text: "Error", hit: true },
      { text: ": ", hit: false },
      { text: "error", hit: true },
    ]);
    const text = "aXbXc";
    const segs = segments(text, [1, 2, 3, 4]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(["X", "X"]);
  });

  it("ignores empty or overlapping ranges", () => {
    expect(segments("abcd", [1, 1, 0, 2, 1, 3])).toEqual([
      { text: "ab", hit: true },
      { text: "c", hit: true },
      { text: "d", hit: false },
    ]);
  });
});

describe("matchCountLabel", () => {
  it("is empty without a search", () => {
    expect(matchCountLabel(false, -1, 0)).toBe("");
  });
  it("counts, and says where the current match is", () => {
    expect(matchCountLabel(true, -1, 0)).toBe("No matches");
    expect(matchCountLabel(true, -1, 1)).toBe("1 match");
    expect(matchCountLabel(true, -1, 12)).toBe("12 matches");
    expect(matchCountLabel(true, 2, 12)).toBe("3 of 12");
  });
});

describe("stepMatch", () => {
  const ids = [3, 7, 20];
  it("starts at the first going forward, the last going back", () => {
    expect(stepMatch(ids, -1, true)).toBe(0);
    expect(stepMatch(ids, -1, false)).toBe(2);
    expect(stepMatch([], -1, true)).toBe(-1);
  });
  it("steps and wraps around", () => {
    expect(stepMatch(ids, 3, true)).toBe(1);
    expect(stepMatch(ids, 20, true)).toBe(0);
    expect(stepMatch(ids, 7, false)).toBe(0);
    expect(stepMatch(ids, 3, false)).toBe(2);
  });
  it("continues from a current match that is gone (trimmed)", () => {
    expect(stepMatch([7, 20], 3, true)).toBe(0);
    expect(stepMatch([7, 20], 10, false)).toBe(0);
  });
  it("starts from a given line", () => {
    expect(stepMatch(ids, -1, true, 8)).toBe(2);
    expect(stepMatch(ids, -1, false, 7)).toBe(1);
  });
});

describe("indexOfId", () => {
  it("bisects", () => {
    expect(indexOfId([1, 4, 9], 4)).toBe(1);
    expect(indexOfId([1, 4, 9], 5)).toBe(-1);
    expect(indexOfId([], 5)).toBe(-1);
  });
});

describe("lineTime", () => {
  it("reads the --timestamps prefix, nanoseconds included", () => {
    expect(lineTime("2026-11-16T10:00:00.123456789Z GET /")).toBe(Date.UTC(2026, 10, 16, 10, 0, 0, 123));
    expect(lineTime("2026-11-16T10:00:00Z x")).toBe(Date.UTC(2026, 10, 16, 10));
  });

  it("reads offsets and local times", () => {
    expect(lineTime("2026-11-16T12:00:00+02:00 x")).toBe(Date.UTC(2026, 10, 16, 10));
    expect(lineTime("2026-11-16T05:30:00-0430 x")).toBe(Date.UTC(2026, 10, 16, 10));
    expect(lineTime("2026-11-16 10:00:00,250 INFO")).toBe(new Date(2026, 10, 16, 10, 0, 0, 250).getTime());
    expect(lineTime("[2026-11-16 10:00] x")).toBe(new Date(2026, 10, 16, 10, 0).getTime());
  });

  it("is NaN for a line without a leading time", () => {
    expect(lineTime("GET / 200")).toBeNaN();
    expect(lineTime("at 2026-11-16T10:00:00Z")).toBeNaN();
  });
});

describe("parseJumpTime", () => {
  const latest = new Date(2026, 10, 16, 14, 0, 0).getTime();

  it("reads a clock time on the newest line's day", () => {
    expect(parseJumpTime("10:30", latest)).toBe(new Date(2026, 10, 16, 10, 30).getTime());
    expect(parseJumpTime(" 9:05:07 ", latest)).toBe(new Date(2026, 10, 16, 9, 5, 7).getTime());
    expect(parseJumpTime("10:30:00.5", latest)).toBe(new Date(2026, 10, 16, 10, 30, 0, 500).getTime());
  });

  it("goes to the day before for a time later than the newest line", () => {
    expect(parseJumpTime("23:00", latest)).toBe(new Date(2026, 10, 15, 23).getTime());
    // A minute of slack.
    expect(parseJumpTime("14:00:30", latest)).toBe(new Date(2026, 10, 16, 14, 0, 30).getTime());
  });

  it("reads full timestamps as they are", () => {
    expect(parseJumpTime("2026-11-01T08:00:00Z", latest)).toBe(Date.UTC(2026, 10, 1, 8));
    expect(parseJumpTime("2026-11-01 08:00", latest)).toBe(new Date(2026, 10, 1, 8).getTime());
  });

  it("is NaN for what is not a time", () => {
    for (const s of ["", "soon", "25:00", "10:61", "10"]) expect(parseJumpTime(s, latest)).toBeNaN();
  });
});

describe("findTime", () => {
  const lines = [
    "no time here",
    "2026-11-16T10:00:00Z a",
    "2026-11-16T10:00:05Z b",
    "  continuation",
    "2026-11-16T10:00:10Z c",
  ];
  const at = (i: number) => lines[i];
  const t = (s: number) => Date.UTC(2026, 10, 16, 10, 0, s);

  it("finds the first line at or after the time", () => {
    expect(findTime(lines.length, at, t(5))).toEqual({ kind: "line", index: 2, first: false });
    expect(findTime(lines.length, at, t(6))).toEqual({ kind: "line", index: 4, first: false });
  });

  it("says when the time is before the first line", () => {
    expect(findTime(lines.length, at, t(-60))).toEqual({ kind: "line", index: 1, first: true });
  });

  it("goes to the newest line when every line is earlier", () => {
    expect(findTime(lines.length, at, t(60))).toEqual({ kind: "after-last", index: 4 });
  });

  it("says when no line has a time; skips system lines", () => {
    expect(findTime(2, (i) => ["a", "b"][i], t(0))).toEqual({ kind: "no-times" });
    expect(findTime(2, () => undefined, t(0))).toEqual({ kind: "no-times" });
  });

  it("scans 50,000 lines quickly", () => {
    const many = Array.from({ length: 50_000 }, (_, i) => new Date(Date.UTC(2026, 10, 16) + i * 10).toISOString() + " line");
    const t0 = performance.now();
    const r = findTime(many.length, (i) => many[i], Date.UTC(2026, 10, 16) + 499_990);
    expect(r).toEqual({ kind: "line", index: 49_999, first: false });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
