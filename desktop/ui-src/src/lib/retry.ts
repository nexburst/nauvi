/**
 * How the UI retries a start that failed (the overview, a table's watch):
 * with a growing wait, and not for ever. After about five minutes it stops
 * and says so; Refresh, a context switch or a new selection starts over.
 * (A watch that was running and lost its connection is retried by the
 * backend, with its own backoff: src/reconnect.rs.)
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
