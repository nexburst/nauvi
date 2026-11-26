import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import {
  GiveUp,
  RETRY_GIVE_UP_MS,
  RETRY_STOPPED,
  anyStalled,
  clearStalled,
  markStalled,
  offersRetry,
  rearmGiveUps,
  reconnectStoppedMessage,
  retryDelay,
  stoppedMessage,
} from "./retry";

describe("retryDelay", () => {
  it("waits longer each time, up to a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it("stops after about five minutes", () => {
    expect(retryDelay(8)).toBeNull();
    expect(retryDelay(50)).toBeNull();
    const total = [1, 2, 3, 4, 5, 6, 7].reduce((sum, n) => sum + retryDelay(n)!, 0);
    expect(total).toBeLessThanOrEqual(RETRY_GIVE_UP_MS);
  });
});

describe("stoppedMessage", () => {
  it("says what failed, then what to do", () => {
    expect(stoppedMessage("Could not reach the cluster")).toBe(`Could not reach the cluster. ${RETRY_STOPPED}`);
    expect(stoppedMessage("failed to load current context:")).toBe(`failed to load current context: ${RETRY_STOPPED}`);
    expect(stoppedMessage("")).toBe(RETRY_STOPPED);
  });
});

describe("a watch that keeps reconnecting", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is stopped once, after five minutes without a break", () => {
    const stop = vi.fn();
    const g = new GiveUp();
    g.arm(stop);
    vi.advanceTimersByTime(RETRY_GIVE_UP_MS - 1);
    // Still reconnecting: arming again does not start the count over.
    g.arm(stop);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("is left alone when it comes back", () => {
    const stop = vi.fn();
    const g = new GiveUp();
    g.arm(stop);
    vi.advanceTimersByTime(60_000);
    g.clear();
    vi.advanceTimersByTime(RETRY_GIVE_UP_MS);
    expect(stop).not.toHaveBeenCalled();
  });

  it("starts its count over on a wake, so the time asleep does not count", () => {
    const stop = vi.fn();
    const g = new GiveUp();
    g.arm(stop);
    vi.advanceTimersByTime(RETRY_GIVE_UP_MS - 1_000);
    rearmGiveUps();
    vi.advanceTimersByTime(RETRY_GIVE_UP_MS - 1_000);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(stop).toHaveBeenCalledTimes(1);
    // Fired or cleared: a later wake does not arm it again.
    rearmGiveUps();
    vi.advanceTimersByTime(2 * RETRY_GIVE_UP_MS);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("is not armed by a wake once cleared", () => {
    const stop = vi.fn();
    const g = new GiveUp();
    g.arm(stop);
    g.clear();
    rearmGiveUps();
    vi.advanceTimersByTime(2 * RETRY_GIVE_UP_MS);
    expect(stop).not.toHaveBeenCalled();
  });

  it("says what failed without the backend's \"retrying\"", () => {
    expect(reconnectStoppedMessage("Lost the connection to the cluster (https://x:6443); retrying.")).toBe(
      `Lost the connection to the cluster (https://x:6443). ${RETRY_STOPPED}`,
    );
    expect(reconnectStoppedMessage("The API server is not answering; retrying.")).toBe(
      `The API server is not answering. ${RETRY_STOPPED}`,
    );
  });
});

describe("stalled feeds", () => {
  it("are counted until each clears itself", () => {
    const a = {};
    const b = {};
    expect(anyStalled()).toBe(false);
    markStalled(a);
    markStalled(b);
    markStalled(a);
    clearStalled(a);
    expect(anyStalled()).toBe(true);
    clearStalled(b);
    expect(anyStalled()).toBe(false);
  });
});

describe("offersRetry", () => {
  it("offers Retry once retrying stopped, or while not connected", () => {
    expect(offersRetry(stoppedMessage("Cannot reach the cluster"), null)).toBe(true);
    expect(offersRetry("Lost the connection; retrying.", false)).toBe(true);
    expect(offersRetry("Could not delete pod web: forbidden", true)).toBe(false);
    expect(offersRetry("", false)).toBe(false);
  });
});
