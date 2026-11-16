import { describe, expect, it } from "vitest";
import { describeError, rateLimiter } from "./uiErrors";

describe("describeError", () => {
  it("uses an Error's name, message and stack", () => {
    const e = new TypeError("x is undefined");
    const d = describeError(e);
    expect(d.message).toBe("TypeError: x is undefined");
    expect(d.stack).toBe(e.stack);
  });

  it("describes strings and other values", () => {
    expect(describeError("boom")).toEqual({ message: "boom", stack: "" });
    expect(describeError({ code: 1 })).toEqual({ message: '{"code":1}', stack: "" });
    expect(describeError(undefined).message).toBe("undefined");
  });

  it("cuts long messages", () => {
    expect(describeError("x".repeat(5000)).message).toHaveLength(1000);
  });
});

describe("rateLimiter", () => {
  it("allows max per window", () => {
    let t = 0;
    const l = rateLimiter(2, 1000, () => t);
    expect([l.take(), l.take(), l.take()]).toEqual([true, true, false]);
    t = 1000;
    expect(l.take()).toBe(true);
  });
});
