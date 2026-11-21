import { afterEach, describe, expect, it, vi } from "vitest";
import { ageTickRunning, onAgeTick } from "./ageClock";

describe("onAgeTick", () => {
  afterEach(() => vi.useRealTimers());

  it("shares one timer between listeners and stops it after the last one", () => {
    vi.useFakeTimers();
    const a = vi.fn();
    const b = vi.fn();
    const offA = onAgeTick(a);
    const offB = onAgeTick(b);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(3);
    offA();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(4);
    offB();
    expect(ageTickRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
