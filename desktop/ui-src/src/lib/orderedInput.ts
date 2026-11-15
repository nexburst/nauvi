/**
 * Keystrokes for a terminal session, sent in order.
 *
 * Each `invoke` of an async Tauri command runs as its own task, so two calls
 * sent back to back can reach the session in either order: fast typing (or
 * a WebDriver typing a word) arrived as "ee2" for "e2e". This keeps one call
 * in flight and sends what was typed meanwhile, joined, in the next one.
 * A failed call is dropped (the session is gone; its close note shows).
 */
export function orderedInput(send: (data: string) => Promise<unknown>): (data: string) => void {
  let queued = "";
  let busy = false;
  async function drain() {
    busy = true;
    while (queued) {
      const data = queued;
      queued = "";
      try {
        await send(data);
      } catch {
        // Dropped, like before: the session is closed or gone.
      }
    }
    busy = false;
  }
  return (data) => {
    queued += data;
    if (!busy) void drain();
  };
}
