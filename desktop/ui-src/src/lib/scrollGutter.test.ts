import { describe, expect, it } from "vitest";
import { gutterWidth } from "./scrollGutter";

describe("gutterWidth", () => {
  it("is what the scrollbar takes from the content", () => {
    expect(gutterWidth({ offsetWidth: 600, clientWidth: 585 })).toBe(15);
  });

  it("is 0 for overlay scrollbars (WebKitGTK) or none", () => {
    expect(gutterWidth({ offsetWidth: 600, clientWidth: 600 })).toBe(0);
    expect(gutterWidth({ offsetWidth: 0, clientWidth: 0 })).toBe(0);
  });
});
