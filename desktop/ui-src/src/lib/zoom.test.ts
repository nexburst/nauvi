import { describe, expect, it } from "vitest";
import { clampTerminalFont, clampZoom, stepZoom } from "./zoom";

describe("stepZoom", () => {
  it("goes to the next step either way", () => {
    expect(stepZoom(100, "in")).toBe(110);
    expect(stepZoom(100, "out")).toBe(90);
    expect(stepZoom(67, "out")).toBe(50);
  });
  it("stops at the ends", () => {
    expect(stepZoom(200, "in")).toBe(200);
    expect(stepZoom(50, "out")).toBe(50);
  });
  it("snaps a value between steps to the next one", () => {
    expect(stepZoom(105, "in")).toBe(110);
    expect(stepZoom(105, "out")).toBe(100);
  });
});

describe("clamping", () => {
  it("keeps the zoom in range", () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(900)).toBe(200);
    expect(clampZoom(NaN)).toBe(100);
    expect(clampZoom(133)).toBe(133);
  });
  it("keeps the terminal font in range", () => {
    expect(clampTerminalFont(3)).toBe(8);
    expect(clampTerminalFont(40)).toBe(32);
    expect(clampTerminalFont(0)).toBe(12);
    expect(clampTerminalFont(14.4)).toBe(14);
  });
});
