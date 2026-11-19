import { describe, expect, it } from "vitest";
import { RETRY_GIVE_UP_MS, RETRY_STOPPED, retryDelay, stoppedMessage } from "./retry";

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
