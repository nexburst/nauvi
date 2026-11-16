import { describe, expect, it } from "vitest";
import { Corpus } from "./logSearchCorpus";

const hit = (t: string) => [0, t.length];
const only = (want: string) => (t: string) => (t === want ? [0, 1] : null);

describe("Corpus (#272)", () => {
  it("numbers the lines from where they start and trims the oldest", () => {
    const c = new Corpus();
    c.load(10);
    c.append(10, 10, ["a", "b"]);
    c.append(12, 11, ["c"]);
    expect(c.size).toBe(2);
    expect(c.map(10, 13, hit)).toEqual([null, [0, 1], [0, 1]]);
  });

  it("starts over at a gap, so later lines keep their numbers", () => {
    const c = new Corpus();
    c.load(0);
    c.append(0, 0, ["a", "b"]);
    // Lines 2 to 4 were trimmed before they were sent.
    c.append(5, 5, ["f", "g"]);
    expect(c.map(4, 7, only("f"))).toEqual([null, [0, 1], null]);
    expect(c.size).toBe(2);
  });

  it("does not add lines it holds already twice", () => {
    const c = new Corpus();
    c.load(0);
    c.append(0, 0, ["a", "b"]);
    c.append(1, 0, ["b", "c"]);
    expect(c.size).toBe(3);
    expect(c.map(2, 3, only("c"))).toEqual([[0, 1]]);
  });
});
