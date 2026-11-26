// When the automatic update check runs while the app is open (#540): every
// 12 hours, up to an hour early or late so the running copies don't all ask
// GitHub at once, and on a wake when the last check is older than that.
// `stores/updates.svelte.ts` keeps the timer.

const HOUR_MS = 3_600_000;

/** How often the automatic check runs while the app is open. */
export const CHECK_EVERY_MS = 12 * HOUR_MS;

/** The wait until the next check: `every`, up to a twelfth of it (an hour) earlier or later. */
export function nextCheckIn(every: number, random: () => number = Math.random): number {
  return Math.round(every + (random() * 2 - 1) * (every / 12));
}

/** Whether a wake should check: no check yet, or the last one is at least `every` old. */
export function dueOnWake(lastCheck: number | null, now: number, every: number): boolean {
  return lastCheck === null || now - lastCheck >= every;
}
