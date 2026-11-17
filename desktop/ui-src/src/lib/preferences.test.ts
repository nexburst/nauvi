import { describe, expect, it } from "vitest";
import { clampEditorFont, clampTabSize, rowHeightPx } from "./preferences";

describe("preferences", () => {
  it("keeps the editor font in range", () => {
    expect(clampEditorFont(2)).toBe(8);
    expect(clampEditorFont(99)).toBe(32);
    expect(clampEditorFont(14.4)).toBe(14);
    expect(clampEditorFont(NaN)).toBe(12);
  });

  it("keeps the tab size in range", () => {
    expect(clampTabSize(0)).toBe(2);
    expect(clampTabSize(4)).toBe(4);
    expect(clampTabSize(20)).toBe(8);
  });

  it("makes compact rows shorter", () => {
    expect(rowHeightPx(28, "normal")).toBe(28);
    expect(rowHeightPx(28, "compact")).toBe(22);
    expect(rowHeightPx(32, "compact")).toBe(26);
  });
});
