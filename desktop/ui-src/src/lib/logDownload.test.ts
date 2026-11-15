import { describe, expect, it } from "vitest";
import { savedLabel } from "./logs";

describe("savedLabel (#178)", () => {
  it("keeps the Downloads folder and the file name", () => {
    expect(savedLabel("/home/tester/Downloads/web-1_app_2026.log")).toBe("Downloads/web-1_app_2026.log");
    expect(savedLabel("/Users/me/Downloads/x.log")).toBe("Downloads/x.log");
  });

  it("handles Windows paths", () => {
    expect(savedLabel("C:\\Users\\me\\Downloads\\x.log")).toBe("Downloads/x.log");
  });

  it("shows just the file name outside a Downloads folder", () => {
    expect(savedLabel("/tmp/out/x.log")).toBe("x.log");
    expect(savedLabel("x.log")).toBe("x.log");
  });
});
