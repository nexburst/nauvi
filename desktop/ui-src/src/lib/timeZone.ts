// The zone times are shown in (#330): local or UTC, from Settings. The
// settings store sets it (`setDisplayZone`); the helpers default to it, and
// components pass `settings.current.time_zone` so they redraw on a change.

import type { TimeZone } from "./bindings";

let current: TimeZone = "local";

export function setDisplayZone(zone: TimeZone) {
  current = zone === "utc" ? "utc" : "local";
}

export function displayZone(): TimeZone {
  return current;
}

/** The calendar fields of `ms` in `zone` (`month` from 0). */
export interface Clock {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function clockParts(ms: number, zone: TimeZone = current): Clock {
  const d = new Date(ms);
  if (zone === "utc") {
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      day: d.getUTCDate(),
      hours: d.getUTCHours(),
      minutes: d.getUTCMinutes(),
      seconds: d.getUTCSeconds(),
    };
  }
  return {
    year: d.getFullYear(),
    month: d.getMonth(),
    day: d.getDate(),
    hours: d.getHours(),
    minutes: d.getMinutes(),
    seconds: d.getSeconds(),
  };
}

/** The time of these fields in `zone`, in ms since the epoch. */
export function fromClock(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
  ms: number,
  zone: TimeZone = current,
): number {
  return zone === "utc"
    ? Date.UTC(year, month, day, hours, minutes, seconds, ms)
    : new Date(year, month, day, hours, minutes, seconds, ms).getTime();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "09:05". */
export function hhmm(ms: number, zone: TimeZone = current): string {
  const c = clockParts(ms, zone);
  return `${pad(c.hours)}:${pad(c.minutes)}`;
}

/** "09:05:03". */
export function hhmmss(ms: number, zone: TimeZone = current): string {
  const c = clockParts(ms, zone);
  return `${pad(c.hours)}:${pad(c.minutes)}:${pad(c.seconds)}`;
}

/** "2026-11-16 09:05:03", with " UTC" in UTC. */
export function dateTime(ms: number, zone: TimeZone = current): string {
  const c = clockParts(ms, zone);
  return `${c.year}-${pad(c.month + 1)}-${pad(c.day)} ${hhmmss(ms, zone)}${zoneSuffix(zone)}`;
}

/** Whether `a` and `b` fall on the same day in `zone`. */
export function sameDay(a: number, b: number, zone: TimeZone = current): boolean {
  const x = clockParts(a, zone);
  const y = clockParts(b, zone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** " UTC" after a time shown in UTC, nothing in local time. */
export function zoneSuffix(zone: TimeZone = current): string {
  return zone === "utc" ? " UTC" : "";
}

/** "local time" or "UTC", for hints. */
export function zoneName(zone: TimeZone = current): string {
  return zone === "utc" ? "UTC" : "local time";
}
