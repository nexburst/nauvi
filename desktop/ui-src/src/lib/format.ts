import type { TimeZone } from "./bindings";
import { dateTime } from "./timeZone";

/** "250m" below one core, otherwise cores ("1.5"). */
export function formatCpu(millicores: number): string {
  if (millicores >= 1000) {
    return (millicores / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  return millicores + "m";
}

/** "0.25 cores", "1 core", for a tooltip next to `formatCpu`'s "250m". */
export function cpuCores(millicores: number): string {
  const cores = Math.round(millicores) / 1000;
  return `${cores} ${cores === 1 ? "core" : "cores"}`;
}

/** Binary units with a space: "512 KiB", "5.5 MiB", "128 MiB", "900 B".
 *  One decimal below 100 of a unit, whole numbers above. */
export function formatMemory(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${bytes} B`;
  const text = value < 100 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value).toString();
  return `${text} ${units[unit]}`;
}

/**
 * Age since `created` (unix seconds), recomputed by the UI so rows stay fresh
 * without a backend update. `fallback` is the backend's own text for objects
 * without a creation time.
 */
export function formatAge(created: number, now: number, fallback: string): string {
  if (!created) return fallback || "";
  return humanDuration(now - created * 1000);
}

/**
 * kubectl's `HumanDuration` (k8s.io/apimachinery/pkg/util/duration) for a
 * duration in ms, as `kubectl get` prints ages: two units while the second
 * still matters (`3m10s`, `3h12m`, `7d20h`, `2y30d`), one otherwise. The same
 * function as `human_duration` in `src/age.rs`, so the table, the detail, the
 * CLI and kubectl agree.
 *
 * One difference: kubectl prints `<invalid>` for a time more than a second in
 * the future; this prints `0s`, since that is clock skew, not a broken object.
 */
export function humanDuration(ms: number): string {
  // Truncate towards zero, like Go's int(d.Seconds()).
  const seconds = Math.trunc(ms / 1000);
  if (seconds < 0) return "0s";
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) return two(minutes, "m", seconds % 60, "s");
  if (minutes < 180) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 8) return two(hours, "h", minutes % 60, "m");
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (hours < 24 * 8) return two(days, "d", hours % 24, "h");
  if (hours < 24 * 365 * 2) return `${days}d`;
  const years = Math.floor(days / 365);
  if (hours < 24 * 365 * 8) return two(years, "y", days % 365, "d");
  return `${years}y`;
}

/**
 * A duration in ms for a sentence ("Pending for 8d 14h", "last 41s ago"): its
 * two largest units with a space, "45s", "3m 5s", "3h 5m", "8d 14h",
 * "1y 20d", the second left out when zero, and seconds from five minutes on
 * ("5m"); never minutes over an hour. The
 * same function as `human::duration` in `src/human.rs`. Table ages keep
 * kubectl's form (`humanDuration`).
 */
export function formatDuration(ms: number): string {
  let secs = Math.max(0, Math.trunc(ms / 1000));
  const total = secs;
  const units: [number, string][] = [
    [365 * 86_400, "y"],
    [86_400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  const i = units.findIndex(([size]) => secs >= size);
  if (i < 0) return "0s";
  const [size, unit] = units[i];
  const first = `${Math.floor(secs / size)}${unit}`;
  secs %= size;
  const next = units[i + 1];
  // From five minutes on, minutes are the smallest unit (src/human.rs).
  if (next && next[0] === 1 && total >= 300) return first;
  return next && Math.floor(secs / next[0]) > 0 ? `${first} ${Math.floor(secs / next[0])}${next[1]}` : first;
}

/**
 * How often an event happened and when last: "821 times, last 41s ago",
 * "41s ago" for one. `time` is unix seconds; without it (0) `fallback`, the
 * backend's age, stands in.
 */
export function eventTimes(count: number, time: number, now: number, fallback = ""): string {
  const ago = time > 0 ? `${formatDuration(now - time * 1000)} ago` : fallback ? `${fallback} ago` : "";
  if (count <= 1) return ago;
  return ago ? `${count} times, last ${ago}` : `${count} times`;
}

/**
 * How often ages need redrawing when the newest object was created at
 * `newest` (unix seconds, 0 for none): every second while some age shows
 * seconds (under 10 minutes), every 15 s otherwise.
 */
export function ageRedrawMs(newest: number, now: number): number {
  return newest > 0 && now - newest * 1000 < 10 * 60_000 ? 1000 : 15_000;
}

function two(a: number, unitA: string, b: number, unitB: string): string {
  return b === 0 ? `${a}${unitA}` : `${a}${unitA}${b}${unitB}`;
}

/** "Created 2026-11-09 14:02:03" (" UTC" after it in UTC), "" without a time. */
export function createdAt(created: number, zone: TimeZone): string {
  return created ? `Created ${dateTime(created * 1000, zone)}` : "";
}
