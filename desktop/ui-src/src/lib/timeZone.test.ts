import { afterEach, describe, expect, it } from "vitest";
import {
  clockParts,
  dateTime,
  displayZone,
  fromClock,
  hhmm,
  hhmmss,
  sameDay,
  setDisplayZone,
  zoneName,
  zoneSuffix,
} from "./timeZone";

const AT = Date.UTC(2026, 10, 16, 23, 5, 3);

afterEach(() => setDisplayZone("local"));

describe("time zone", () => {
  it("formats in UTC", () => {
    expect(hhmm(AT, "utc")).toBe("23:05");
    expect(hhmmss(AT, "utc")).toBe("23:05:03");
    expect(dateTime(AT, "utc")).toBe("2026-11-16 23:05:03 UTC");
    expect(clockParts(AT, "utc")).toEqual({ year: 2026, month: 10, day: 16, hours: 23, minutes: 5, seconds: 3 });
  });

  it("formats in local time", () => {
    const d = new Date(AT);
    const local = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(hhmm(AT, "local")).toBe(local);
    expect(dateTime(AT, "local")).not.toContain("UTC");
  });

  it("follows the display zone by default", () => {
    expect(displayZone()).toBe("local");
    setDisplayZone("utc");
    expect(hhmm(AT)).toBe("23:05");
    expect(zoneSuffix()).toBe(" UTC");
    expect(zoneName()).toBe("UTC");
    setDisplayZone("local");
    expect(zoneSuffix()).toBe("");
    expect(zoneName()).toBe("local time");
  });

  it("reads fields back in either zone", () => {
    expect(fromClock(2026, 10, 16, 23, 5, 3, 0, "utc")).toBe(AT);
    expect(fromClock(2026, 10, 16, 23, 5, 3, 0, "local")).toBe(new Date(2026, 10, 16, 23, 5, 3).getTime());
  });

  it("compares days in the zone", () => {
    expect(sameDay(AT, Date.UTC(2026, 10, 17, 0, 30), "utc")).toBe(false);
    expect(sameDay(AT, AT + 60_000, "utc")).toBe(true);
  });
});
