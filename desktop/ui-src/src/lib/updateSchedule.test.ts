import { describe, expect, it } from "vitest";
import { CHECK_EVERY_MS, dueOnWake, nextCheckIn } from "./updateSchedule";

const HOUR = 3_600_000;

describe("nextCheckIn", () => {
  it("is 12 h, at most an hour earlier or later", () => {
    expect(CHECK_EVERY_MS).toBe(12 * HOUR);
    expect(nextCheckIn(CHECK_EVERY_MS, () => 0)).toBe(11 * HOUR);
    expect(nextCheckIn(CHECK_EVERY_MS, () => 0.5)).toBe(12 * HOUR);
    for (let i = 0; i < 100; i++) {
      const d = nextCheckIn(CHECK_EVERY_MS);
      expect(d).toBeGreaterThanOrEqual(11 * HOUR);
      expect(d).toBeLessThanOrEqual(13 * HOUR);
    }
  });

  it("scales the offset with a shorter interval", () => {
    expect(nextCheckIn(12_000, () => 0)).toBe(11_000);
    expect(nextCheckIn(12_000, () => 1)).toBe(13_000);
  });
});

describe("dueOnWake", () => {
  it("checks when there was no check yet or the last one is 12 h old", () => {
    expect(dueOnWake(null, 0, CHECK_EVERY_MS)).toBe(true);
    expect(dueOnWake(0, 12 * HOUR - 1, CHECK_EVERY_MS)).toBe(false);
    expect(dueOnWake(0, 12 * HOUR, CHECK_EVERY_MS)).toBe(true);
  });
});
