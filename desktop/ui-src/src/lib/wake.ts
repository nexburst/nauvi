/**
 * Notices the machine waking up or the network coming back (#526), so a
 * feed that stopped retrying while the laptop slept (or the VPN was down)
 * starts again by itself.
 *
 * Three signs, whichever comes first:
 * - `online` on the window: a network interface came up;
 * - `visibilitychange` to visible: the window shows again (a wake often
 *   shows it, and so does un-minimising);
 * - a tick that comes much later than asked: timers do not run while the
 *   machine sleeps, but the wall clock does, so the first tick after a
 *   wake sees the gap.
 */

export type WakeReason = "online" | "visible" | "sleep";

/** How often the sleep detector ticks. */
export const WAKE_TICK_MS = 10_000;
/** A tick this much later than due means the machine slept. */
export const SLEEP_GAP_MS = 30_000;
/** Signs this close together are one wake (online, then visible, then the tick). */
export const WAKE_SPACING_MS = 5_000;

interface Targets {
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  now?: () => number;
}

/** Call `onWake` on each wake; returns a function that stops listening. */
export function watchWake({ win, doc, now = Date.now }: Targets, onWake: (why: WakeReason) => void): () => void {
  let last = -Infinity;
  const fire = (why: WakeReason) => {
    const t = now();
    if (t - last < WAKE_SPACING_MS) return;
    last = t;
    onWake(why);
  };
  const onOnline = () => fire("online");
  const onVisibility = () => {
    if (doc.visibilityState === "visible") fire("visible");
  };
  let lastTick = now();
  const timer = setInterval(() => {
    const t = now();
    const late = t - lastTick - WAKE_TICK_MS;
    lastTick = t;
    if (late >= SLEEP_GAP_MS) fire("sleep");
  }, WAKE_TICK_MS);
  win.addEventListener("online", onOnline);
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(timer);
    win.removeEventListener("online", onOnline);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
