import { anyStalled, rearmGiveUps } from "../retry";
import { watchWake } from "../wake";
import { refresh } from "./app.svelte";

/**
 * After a sleep or a network change (lib/wake.ts), restart the feeds that
 * stopped or wait for their next retry, from a fresh backoff: what Retry
 * and Refresh do (#526). Watches still reconnecting in the backend start
 * their five minutes over, so the time asleep does not count. A window
 * that only shows again restarts stalled feeds, nothing more.
 */
export function retryOnWake(win: Window, doc: Document): () => void {
  return watchWake({ win, doc }, (why) => {
    if (why !== "visible") rearmGiveUps();
    if (anyStalled()) refresh();
  });
}
