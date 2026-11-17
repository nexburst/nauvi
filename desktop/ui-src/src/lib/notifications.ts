// Notification history (#326): every notice and error banner the window
// showed, newest first, kept in memory for this window only.

import type { ResourceRef } from "./bindings";

export type NotificationLevel = "success" | "info" | "warning" | "error";

/** The object a notification is about, opened from the history. */
export interface NotificationTarget {
  resource: ResourceRef;
  /** Empty for cluster-scoped kinds. */
  namespace: string;
  name: string;
}

export interface NotificationEntry {
  id: number;
  /** Milliseconds since the epoch, of the last time it was shown. */
  at: number;
  level: NotificationLevel;
  message: string;
  /** The context the window was connected to; empty if none. */
  context: string;
  target: NotificationTarget | null;
  /** How many times in a row it was shown (repeats are folded). */
  count: number;
}

/** How many notifications a window keeps. */
export const NOTIFICATION_CAP = 200;

/**
 * The history with `entry` added at the front, capped at `cap`. The same
 * message shown again right after (same level, context and object) bumps
 * the newest entry instead of adding another one.
 */
export function addNotification(
  list: readonly NotificationEntry[],
  entry: Omit<NotificationEntry, "count">,
  cap = NOTIFICATION_CAP,
): NotificationEntry[] {
  const last = list[0];
  if (
    last &&
    last.level === entry.level &&
    last.message === entry.message &&
    last.context === entry.context &&
    sameTarget(last.target, entry.target)
  ) {
    return [{ ...last, at: entry.at, count: last.count + 1 }, ...list.slice(1)];
  }
  return [{ ...entry, count: 1 }, ...list.slice(0, Math.max(0, cap - 1))];
}

export function sameTarget(a: NotificationTarget | null, b: NotificationTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.resource.group === b.resource.group &&
    a.resource.kind === b.resource.kind &&
    a.namespace === b.namespace &&
    a.name === b.name
  );
}

/** The badge on the bell: nothing for 0, "99+" past 99. */
export function badgeText(unread: number): string {
  if (unread <= 0) return "";
  return unread > 99 ? "99+" : String(unread);
}

/** "14:03:27" today, "Nov 15 14:03" on another day. */
export function notificationTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (new Date(now).toDateString() === d.toDateString()) return time;
  const month = d.toLocaleString("en", { month: "short" });
  return `${month} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Pod demo/web-1", "Node kind-control-plane". */
export function targetText(t: NotificationTarget): string {
  return `${t.resource.kind} ${t.namespace ? `${t.namespace}/` : ""}${t.name}`;
}

/** Why the history cannot open the object, or "" when it can. */
export function openProblem(entry: NotificationEntry, currentContext: string): string {
  if (!entry.target) return "";
  if (entry.context !== currentContext) return `This was in context ${entry.context}: switch to it to open the object.`;
  return "";
}
