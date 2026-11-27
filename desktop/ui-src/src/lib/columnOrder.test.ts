import { describe, expect, it } from "vitest";
import { moveKey, moveTo, orderChanged, orderColumns } from "./columnOrder";

const cols = (...keys: string[]) => keys.map((key) => ({ key }));
const keys = (c: { key: string }[]) => c.map((x) => x.key);

describe("column order (#547)", () => {
  it("is the kind's own without one", () => {
    expect(keys(orderColumns(cols("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
  });

  it("follows the remembered keys", () => {
    expect(keys(orderColumns(cols("a", "b", "c"), ["c", "a", "b"]))).toEqual(["c", "a", "b"]);
  });

  it("keeps a column it does not name after the one it follows, and drops gone keys", () => {
    // `d` is new (a custom column, or a later version's): after `c`.
    expect(keys(orderColumns(cols("a", "b", "c", "d"), ["c", "a", "b"]))).toEqual(["c", "d", "a", "b"]);
    // New and first: first.
    expect(keys(orderColumns(cols("z", "a", "b"), ["b", "a"]))).toEqual(["z", "b", "a"]);
    expect(keys(orderColumns(cols("a", "b"), ["gone", "b", "a", "b"]))).toEqual(["b", "a"]);
  });

  it("moves a key by places or to an index", () => {
    expect(moveKey(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveKey(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveKey(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveKey(["a", "b", "c"], "c", 5)).toEqual(["a", "b", "c"]);
    expect(moveKey(["a", "b"], "x", 1)).toEqual(["a", "b"]);
    expect(moveTo(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveTo(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("knows when the order differs from the kind's", () => {
    expect(orderChanged(cols("a", "b"), [])).toBe(false);
    expect(orderChanged(cols("a", "b"), ["a", "b"])).toBe(false);
    expect(orderChanged(cols("a", "b"), ["b", "a"])).toBe(true);
    expect(orderChanged(cols("a", "b"), ["b"])).toBe(false);
  });
});
