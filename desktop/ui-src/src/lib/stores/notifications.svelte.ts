// The notification history of this window (#326): what `setNotice` and
// `showError` showed, for the bell in the header and its side panel. In
// memory only, capped at NOTIFICATION_CAP.

import { addNotification } from "../notifications";
import type { NotificationEntry, NotificationLevel, NotificationTarget } from "../notifications";

class Notifications {
  list = $state.raw<NotificationEntry[]>([]);
  /** Shown since the panel was last open. */
  unread = $state(0);
  open = $state(false);
}
export const notifications = new Notifications();

let nextId = 1;

/** Record a notification; it counts as unread unless the panel is open. */
export function notify(
  level: NotificationLevel,
  message: string,
  context: string,
  target: NotificationTarget | null = null,
) {
  if (!message) return;
  const newest = notifications.list[0];
  notifications.list = addNotification(notifications.list, {
    id: nextId++,
    at: Date.now(),
    level,
    message,
    context,
    target,
  });
  // A repeat of the newest notice only raises its count: it is not one
  // more thing to read (a cluster that stays unreachable used to add one
  // unread notice per retry).
  const repeat = !!newest && notifications.list[0]?.id === newest.id && notifications.unread > 0;
  if (!notifications.open && !repeat) notifications.unread++;
}

export function toggleNotifications() {
  notifications.open = !notifications.open;
  notifications.unread = 0;
}

export function closeNotifications() {
  notifications.open = false;
  notifications.unread = 0;
}

export function clearNotifications() {
  notifications.list = [];
  notifications.unread = 0;
}
