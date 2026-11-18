import { describe, expect, it } from "vitest";
import { BADGES, emptyLog, observe, parseLog, recentHours, streakText } from "./watch";

const T0 = new Date(2026, 10, 18, 9, 0).getTime();
const MIN = 60_000;

describe("watch log", () => {
  it("counts problems that leave the list as cleared, not the first list of a feed", () => {
    let o = observe(emptyLog(T0), ["demo/a", "demo/b"], 2, T0, true);
    expect(o.cleared).toEqual([]);
    o = observe(o.log, ["demo/b"], 1, T0 + MIN, false);
    expect(o.cleared).toEqual(["demo/a"]);
    expect(o.log.cleared).toBe(1);
    expect(o.earned.map((b) => b.id)).toEqual(["steady-hand"]);
    // A new feed (another namespace) is a new baseline.
    o = observe(o.log, [], 0, T0 + 2 * MIN, true);
    expect(o.cleared).toEqual([]);
  });

  it("does not guess who left a list that was cut short", () => {
    let o = observe(emptyLog(T0), ["demo/a"], 5, T0, true);
    o = observe(o.log, ["demo/b"], 4, T0 + MIN, false);
    expect(o.cleared).toEqual([]);
  });

  it("keeps a calm streak, breaks it on a problem or when nobody watched", () => {
    let o = observe(emptyLog(T0), [], 0, T0, true);
    expect(o.log.calmSince).toBe(T0);
    expect(o.earned.map((b) => b.id)).toEqual(["first-light"]);
    o = observe(o.log, [], 0, T0 + 5 * MIN, false);
    expect(o.log.calmSince).toBe(T0);
    // Updates every few minutes: still watched.
    for (let m = 10; m < 60; m += 5) o = observe(o.log, [], 0, T0 + m * MIN, false);
    expect(o.earned).toEqual([]);
    o = observe(o.log, [], 0, T0 + 61 * MIN, false);
    expect(o.earned.map((b) => b.id)).toEqual(["calm-hour"]);
    o = observe(o.log, ["demo/a"], 1, T0 + 62 * MIN, false);
    expect(o.log.calmSince).toBeNull();
    expect(o.log.bestCalm).toBe(61 * MIN);
    // An hour away: the streak starts again from now.
    o = observe(o.log, [], 0, T0 + 63 * MIN, false);
    o = observe(o.log, [], 0, T0 + 130 * MIN, false);
    expect(o.log.calmSince).toBe(T0 + 130 * MIN);
  });

  it("marks hours rough once, calm otherwise, and keeps 24", () => {
    let l = emptyLog(T0);
    for (let h = 0; h < 30; h++) l = observe(l, [], 0, T0 + h * 60 * MIN, false).log;
    l = observe(l, ["x/y"], 1, T0 + 29 * 60 * MIN + MIN, false).log;
    expect(Object.keys(l.hours)).toHaveLength(24);
    const hours = recentHours(l, T0 + 29 * 60 * MIN + MIN, 3);
    expect(hours.map((h) => h.mark)).toEqual(["calm", "calm", "rough"]);
    expect(recentHours(emptyLog(T0), T0, 2).map((h) => h.mark)).toEqual([null, null]);
  });

  it("reads a broken store as a new log", () => {
    expect(parseLog("{nope", T0).cleared).toBe(0);
    expect(parseLog(null, T0).badges).toEqual({});
    const saved = observe(emptyLog(T0), [], 0, T0, true).log;
    expect(parseLog(JSON.stringify(saved), T0).badges).toEqual(saved.badges);
  });

  it("shows progress toward locked badges", () => {
    const l = { ...emptyLog(T0), cleared: 3 };
    expect(BADGES.find((b) => b.id === "clear-decks")!.progress(l, T0)).toEqual({ value: 0.3, text: "3 / 10" });
    expect(streakText(42 * MIN)).toBe("42m");
    expect(streakText(185 * MIN)).toBe("3h 05m");
    expect(streakText(50 * 60 * MIN)).toBe("2d 2h");
  });
});
