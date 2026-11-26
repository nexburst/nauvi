import { describe, expect, it } from "vitest";
import { placeTip, tipDelay, TIP_DELAY_MS, TIP_GAP, TIP_MARGIN, TIP_QUICK_MS } from "./tooltip";

const view = { width: 1280, height: 800 };

describe("placeTip", () => {
  it("goes under the anchor, centred", () => {
    const p = placeTip({ x: 100, y: 10, width: 40, height: 20 }, { width: 80, height: 24 }, view);
    expect(p).toEqual({ x: 80, y: 30 + TIP_GAP, above: false });
  });

  it("stays inside the window at the edges", () => {
    expect(placeTip({ x: 0, y: 10, width: 20, height: 20 }, { width: 200, height: 24 }, view).x).toBe(TIP_MARGIN);
    const right = placeTip({ x: 1270, y: 10, width: 10, height: 20 }, { width: 200, height: 24 }, view);
    expect(right.x).toBe(1280 - 200 - TIP_MARGIN);
  });

  it("goes above when there is no room below", () => {
    const p = placeTip({ x: 600, y: 780, width: 100, height: 16 }, { width: 120, height: 60 }, view);
    expect(p.above).toBe(true);
    expect(p.y).toBe(780 - TIP_GAP - 60);
  });
});

describe("tipDelay", () => {
  it("waits on a first tip and is quick right after another", () => {
    expect(tipDelay(10_000, 0)).toBe(TIP_DELAY_MS);
    expect(tipDelay(10_000, 9_800)).toBe(TIP_QUICK_MS);
    expect(tipDelay(10_000, 5_000)).toBe(TIP_DELAY_MS);
  });
});
