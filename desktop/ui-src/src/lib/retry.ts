/**
 * How the UI retries a start that failed (the overview, a table's watch):
 * with a growing wait, and not for ever. After about five minutes it stops
 * and says so; Retry in the banner, Refresh, a context switch or a new
 * selection starts over, and so does the machine waking up or the network
 * coming back (#526, lib/wake.ts): a feed that is not running then counts
 * as stalled ({@link markStalled}).
 *
 * A watch that was running and lost its connection is reconnected by the
 * backend (src/reconnect.rs: every second at first, every ten at most). It
 * does not stop by itself, so the UI stops it: after the same five minutes
 * of Reconnecting, the watch is stopped and the view says so ({@link GiveUp}).
 */

/** The first wait; each next one doubles. */
export const RETRY_FIRST_MS = 5_000;
/** No wait is longer than this. */
export const RETRY_MAX_MS = 60_000;
/** Retries are scheduled only while they would start within this. */
export const RETRY_GIVE_UP_MS = 5 * 60_000;

/** Added to the error once retrying has stopped. */
export const RETRY_STOPPED = "Stopped retrying.";

/**
 * How long to wait before retry number `attempt` (1 for the first retry),
 * or null when it is time to stop: 5 s, 10 s, 20 s, 40 s, then every 60 s,
 * seven retries in all.
 */
export function retryDelay(attempt: number): number | null {
  let elapsed = 0;
  let delay = RETRY_FIRST_MS;
  for (let n = 1; ; n++) {
    if (elapsed + delay > RETRY_GIVE_UP_MS) return null;
    if (n >= attempt) return delay;
    elapsed += delay;
    delay = Math.min(RETRY_MAX_MS, delay * 2);
  }
}

/** The message of a failure that will not be retried: the error, then what to do. */
export function stoppedMessage(error: string): string {
  const e = error.trim();
  return e ? `${e}${/[.!?:]$/.test(e) ? "" : "."} ${RETRY_STOPPED}` : RETRY_STOPPED;
}

/**
 * The message of a watch the UI stopped after it kept reconnecting: the
 * backend's text without its "; retrying.", then what to do.
 */
export function reconnectStoppedMessage(error: string): string {
  return stoppedMessage(error.replace(/[;,.]?\s*retrying\.?\s*$/i, ""));
}

/** The armed counters, so a wake can start them over ({@link rearmGiveUps}). */
const armed = new Set<GiveUp>();

/**
 * Stops waiting for a reconnect: armed when a watch starts reconnecting,
 * cleared when it is live again or stopped; fires once, after
 * {@link RETRY_GIVE_UP_MS} of uninterrupted reconnecting.
 */
export class GiveUp {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stop: (() => void) | null = null;

  /** Start counting, unless already counting. */
  arm(stop: () => void) {
    if (this.#timer) return;
    this.#stop = stop;
    armed.add(this);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#stop = null;
      armed.delete(this);
      stop();
    }, RETRY_GIVE_UP_MS);
  }

  clear() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#stop = null;
    armed.delete(this);
  }

  /** Count from now again, if counting. */
  rearm() {
    const stop = this.#stop;
    if (!stop) return;
    this.clear();
    this.arm(stop);
  }
}

/**
 * Start every running count over: the time asleep, or before the network
 * came back, does not count toward giving up (#526).
 */
export function rearmGiveUps() {
  for (const g of [...armed]) g.rearm();
}

/**
 * Feeds that are not running and wait for a retry, or gave up: a wake or
 * the network coming back restarts them (lib/wake.ts). Keyed by any object
 * the feed owns.
 */
const stalled = new Set<object>();

export function markStalled(owner: object) {
  stalled.add(owner);
}

export function clearStalled(owner: object) {
  stalled.delete(owner);
}

export function anyStalled(): boolean {
  return stalled.size > 0;
}

/**
 * Whether the banner offers Retry: retrying stopped, or the header says the
 * view is not connected (#526). Retry is the same action as Refresh.
 */
export function offersRetry(error: string, statusOk: boolean | null): boolean {
  return error !== "" && (error.includes(RETRY_STOPPED) || statusOk === false);
}
