import { describe, expect, it } from "vitest";
import { tabIndex } from "./dialogFocus";

describe("tabIndex", () => {
  it("goes round the dialog's elements both ways", () => {
    expect(tabIndex(0, 2, false)).toBe(1);
    expect(tabIndex(1, 2, false)).toBe(0);
    expect(tabIndex(0, 2, true)).toBe(1);
    expect(tabIndex(1, 3, true)).toBe(0);
  });

  it("starts at either end when the focus is outside", () => {
    expect(tabIndex(-1, 3, false)).toBe(0);
    expect(tabIndex(-1, 3, true)).toBe(2);
    expect(tabIndex(-1, 0, false)).toBe(-1);
  });
});
