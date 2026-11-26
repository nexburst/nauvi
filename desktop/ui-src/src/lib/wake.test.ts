import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLEEP_GAP_MS, WAKE_SPACING_MS, WAKE_TICK_MS, watchWake } from "./wake";

/** A window and document that only dispatch events. */
function targets() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  return { win, doc };
}

describe("watchWake", () => {
  let clock = 0;
  const now = () => clock;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
  });
  afterEach(() => vi.useRealTimers());

  it("wakes when the network comes back and when the window shows again", () => {
    const { win, doc } = targets();
    const woke = vi.fn();
    const stop = watchWake({ win, doc, now }, woke);
    win.dispatchEvent(new Event("online"));
    expect(woke).toHaveBeenLastCalledWith("online");
    clock += WAKE_SPACING_MS;
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(woke).toHaveBeenCalledTimes(1);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(woke).toHaveBeenLastCalledWith("visible");
    expect(woke).toHaveBeenCalledTimes(2);
    stop();
    clock += WAKE_SPACING_MS;
    win.dispatchEvent(new Event("online"));
    expect(woke).toHaveBeenCalledTimes(2);
  });

  it("takes signs close together for one wake", () => {
    const { win, doc } = targets();
    const woke = vi.fn();
    const stop = watchWake({ win, doc, now }, woke);
    win.dispatchEvent(new Event("online"));
    clock += WAKE_SPACING_MS - 1;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(woke).toHaveBeenCalledTimes(1);
    stop();
  });

  it("notices a sleep from a tick that comes late", () => {
    const { win, doc } = targets();
    const woke = vi.fn();
    const stop = watchWake({ win, doc, now }, woke);
    // On time, or a little late: no wake.
    clock += WAKE_TICK_MS + 2_000;
    vi.advanceTimersByTime(WAKE_TICK_MS);
    expect(woke).not.toHaveBeenCalled();
    // The machine slept: the wall clock moved on, the timer did not.
    clock += WAKE_TICK_MS + SLEEP_GAP_MS;
    vi.advanceTimersByTime(WAKE_TICK_MS);
    expect(woke).toHaveBeenCalledWith("sleep");
    stop();
    clock += 10 * SLEEP_GAP_MS;
    vi.advanceTimersByTime(WAKE_TICK_MS);
    expect(woke).toHaveBeenCalledTimes(1);
  });
});
