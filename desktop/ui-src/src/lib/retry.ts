/**
 * How the UI retries a start that failed (the overview, a table's watch):
 * with a growing wait, and not for ever. After about five minutes it stops
 * and says so; Refresh, a context switch or a new selection starts over.
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
export const RETRY_STOPPED = "Stopped retrying. Refresh to try again.";

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

/**
 * Stops waiting for a reconnect: armed when a watch starts reconnecting,
 * cleared when it is live again or stopped; fires once, after
 * {@link RETRY_GIVE_UP_MS} of uninterrupted reconnecting.
 */
export class GiveUp {
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** Start counting, unless already counting. */
  arm(stop: () => void) {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      stop();
    }, RETRY_GIVE_UP_MS);
  }

  clear() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
