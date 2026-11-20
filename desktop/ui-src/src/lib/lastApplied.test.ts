import { describe, expect, it } from "vitest";
import { hasMasked, prettyJson, sizeText } from "./lastApplied";

describe("lastApplied", () => {
  it("sizes in bytes, then KB", () => {
    expect(sizeText("abc")).toBe("3 B");
    expect(sizeText("x".repeat(3500))).toBe("3.4 KB");
    expect(sizeText("••")).toBe("6 B");
  });

  it("indents JSON and leaves anything else alone", () => {
    expect(prettyJson('{"a":{"b":1}}')).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
    expect(prettyJson("<hidden: reveal to view>")).toBe("<hidden: reveal to view>");
  });

  it("sees the mask", () => {
    expect(hasMasked('{"args":["--token=••••"]}')).toBe(true);
    expect(hasMasked('{"args":[]}')).toBe(false);
  });
});
