import type { TimeZone } from "./bindings";
import { dateTime } from "./timeZone";

/** "250m" below one core, otherwise cores ("1.5"). */
export function formatCpu(millicores: number): string {
  if (millicores >= 1000) {
    return (millicores / 1000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  return millicores + "m";
}

/** Binary units ("128Mi"). */
export function formatMemory(bytes: number): string {
  const units = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return bytes + "B";
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") + units[unit];
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

function two(a: number, unitA: string, b: number, unitB: string): string {
  return b === 0 ? `${a}${unitA}` : `${a}${unitA}${b}${unitB}`;
}

/** "Created 2026-11-09 14:02:03" (" UTC" after it in UTC), "" without a time. */
export function createdAt(created: number, zone: TimeZone): string {
  return created ? `Created ${dateTime(created * 1000, zone)}` : "";
}
