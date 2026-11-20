import { describe, expect, it } from "vitest";
import { createdAt, formatAge, formatCpu, formatMemory, humanDuration } from "./format";

describe("formatCpu", () => {
  it("uses millicores below one core", () => {
    expect(formatCpu(0)).toBe("0m");
    expect(formatCpu(250)).toBe("250m");
    expect(formatCpu(999)).toBe("999m");
  });
  it("uses cores from one core, without trailing zeros", () => {
    expect(formatCpu(1000)).toBe("1");
    expect(formatCpu(1500)).toBe("1.5");
    expect(formatCpu(2250)).toBe("2.25");
    expect(formatCpu(4001)).toBe("4");
  });
});

describe("formatMemory", () => {
  it("keeps bytes below 1Ki", () => {
    expect(formatMemory(0)).toBe("0B");
    expect(formatMemory(1023)).toBe("1023B");
  });
  it("uses binary units without trailing zeros", () => {
    expect(formatMemory(1024)).toBe("1Ki");
    expect(formatMemory(128 * 1024 * 1024)).toBe("128Mi");
    expect(formatMemory(1.5 * 1024 ** 3)).toBe("1.5Gi");
    expect(formatMemory(2 * 1024 ** 4)).toBe("2Ti");
  });
  it("stops at Pi", () => {
    expect(formatMemory(2048 * 1024 ** 5)).toBe("2048Pi");
  });
});

describe("formatAge", () => {
  const now = 1_000_000_000; // ms
  const created = (secsAgo: number) => now / 1000 - secsAgo;
  it("falls back to the backend's text without a creation time", () => {
    expect(formatAge(0, now, "<unknown>")).toBe("<unknown>");
    expect(formatAge(0, now, "")).toBe("");
  });
  it("prints ages like kubectl get", () => {
    expect(formatAge(created(5), now, "")).toBe("5s");
    expect(formatAge(created(119), now, "")).toBe("119s");
    expect(formatAge(created(190), now, "")).toBe("3m10s");
    expect(formatAge(created(3 * 3600 + 12 * 60 + 40), now, "")).toBe("3h12m");
    expect(formatAge(created(86399), now, "")).toBe("23h");
    expect(formatAge(created(86400 * 3), now, "")).toBe("3d");
    expect(formatAge(created(7 * 86400 + 20 * 3600 + 300), now, "")).toBe("7d20h");
  });
  it("never goes negative for clock skew", () => {
    expect(formatAge(created(-30), now, "")).toBe("0s");
  });
});

describe("humanDuration", () => {
  const MS = 1;
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const YEAR = 365 * DAY;
  // kubectl's TestHumanDuration and TestHumanDurationBoundaries
  // (k8s.io/apimachinery/pkg/util/duration/duration_test.go), row for row;
  // `src/age.rs` has the same table.
  const table: [number, string][] = [
    [SEC, "1s"],
    [70 * SEC, "70s"],
    [190 * SEC, "3m10s"],
    [70 * MIN, "70m"],
    [47 * HOUR, "47h"],
    [49 * HOUR, "2d1h"],
    [(8 * 24 + 2) * HOUR, "8d"],
    [367 * DAY, "367d"],
    [2 * YEAR + 25 * HOUR, "2y1d"],
    [8 * YEAR + 2 * HOUR, "8y"],
    // Boundaries.
    [-2 * SEC + MS, "0s"],
    [0, "0s"],
    [SEC - MS, "0s"],
    [2 * MIN - MS, "119s"],
    [2 * MIN, "2m"],
    [2 * MIN + SEC, "2m1s"],
    [10 * MIN - MS, "9m59s"],
    [10 * MIN, "10m"],
    [3 * HOUR - MS, "179m"],
    [3 * HOUR, "3h"],
    [3 * HOUR + MIN, "3h1m"],
    [8 * HOUR - MS, "7h59m"],
    [8 * HOUR, "8h"],
    [48 * HOUR - MS, "47h"],
    [48 * HOUR, "2d"],
    [48 * HOUR + HOUR, "2d1h"],
    [8 * DAY - MS, "7d23h"],
    [8 * DAY, "8d"],
    [2 * YEAR - MS, "729d"],
    [2 * YEAR, "2y"],
    [2 * YEAR + 23 * HOUR, "2y"],
    [2 * YEAR + 23 * HOUR + 59 * MIN, "2y"],
    [2 * YEAR + DAY - MS, "2y"],
    [2 * YEAR + DAY, "2y1d"],
    [3 * YEAR, "3y"],
    [4 * YEAR, "4y"],
    [5 * YEAR, "5y"],
    [6 * YEAR, "6y"],
    [7 * YEAR, "7y"],
    [8 * YEAR - MS, "7y364d"],
    [8 * YEAR, "8y"],
    [8 * YEAR + 364 * DAY, "8y"],
    [9 * YEAR, "9y"],
  ];
  it.each(table)("%d ms is %s", (ms, want) => {
    expect(humanDuration(ms)).toBe(want);
  });
  it("prints 0s, not kubectl's <invalid>, for times in the future", () => {
    expect(humanDuration(-2 * SEC)).toBe("0s");
    expect(humanDuration(-100 * SEC)).toBe("0s");
  });
});

describe("createdAt", () => {
  it("prints the creation time in the display zone", () => {
    const t = Date.UTC(2026, 10, 9, 14, 2, 3) / 1000;
    expect(createdAt(t, "utc")).toBe("Created 2026-11-09 14:02:03 UTC");
    expect(createdAt(0, "utc")).toBe("");
  });
});
