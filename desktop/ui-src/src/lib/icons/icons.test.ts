import { describe, expect, it } from "vitest";
import { ICONS, circle, gear, rect } from "./icons";

/** The numbers of a path, absolute or relative, as the parser would read them. */
function numbers(d: string): number[] {
  return (d.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
}

describe("the icon set", () => {
  it("has paths for every icon, in path syntax only", () => {
    for (const [name, paths] of Object.entries(ICONS)) {
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, name).toMatch(/^M/);
        expect(d, name).toMatch(/^[MmLlHhVvAaCcSsQqZz0-9.\s-]+$/);
        expect(numbers(d).every(Number.isFinite), name).toBe(true);
      }
    }
  });

  it("draws on the 24-unit grid", () => {
    // Absolute coordinates (after M, L and the end points of A) stay inside it.
    for (const [name, paths] of Object.entries(ICONS)) {
      for (const d of paths) {
        const [x, y] = numbers(d);
        expect(x, name).toBeGreaterThanOrEqual(0);
        expect(x, name).toBeLessThanOrEqual(24);
        expect(y, name).toBeGreaterThanOrEqual(0);
        expect(y, name).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe("shape helpers", () => {
  it("a circle starts at its left edge and spans its diameter", () => {
    expect(circle(12, 12, 9)).toBe("M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0");
  });

  it("a rectangle closes, with or without rounded corners", () => {
    expect(rect(4, 4, 6, 6)).toBe("M4 4h6v6h-6z");
    expect(rect(4, 4, 16, 7, 1.5)).toMatch(/^M5\.5 4h13a1\.5 1\.5 0 0 1 1\.5 1\.5v4.*z$/);
  });

  it("a gear has one arc per tooth and stays inside its outer radius", () => {
    const d = gear(8, 7.4, 9.6);
    expect(d.match(/A/g)).toHaveLength(8);
    const pts = d.replace(/A[\d.]+ [\d.]+ 0 0 1 /g, "L").match(/[ML][\d.]+ [\d.]+/g) ?? [];
    for (const p of pts) {
      const [x, y] = p.slice(1).split(" ").map(Number);
      expect(Math.hypot(x - 12, y - 12)).toBeLessThanOrEqual(9.61);
    }
  });
});
