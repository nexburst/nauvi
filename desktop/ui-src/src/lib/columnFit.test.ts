import { describe, expect, it } from "vitest";
import { fitWidths, longest, middleCut, minTotal, sample, settle } from "./columnFit";
import type { Fit, FitInput } from "./columnFit";

const NAME: Fit = { min: 168, max: 640, grow: 2, give: 3, middle: true };
const NS: Fit = { min: 96, max: 320, grow: 1, give: 2, middle: true };
const TEXT: Fit = { min: 72, max: 360, grow: 0, give: 1 };
const SHORT: Fit = { min: 48, max: 120, grow: 0, give: 0 };
const col = (fit: Fit, natural: number, user?: number): FitInput => ({ fit, natural, user });
const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);
/** 7 px a character, as a fixed-width font would. */
const mono = (t: string) => t.length * 7;

describe("fitWidths", () => {
  it("gives each column its content's width, and the spare to Name", () => {
    const w = fitWidths([col(NAME, 200), col(NS, 110), col(SHORT, 60), col(SHORT, 70)], 800);
    expect(w).toEqual([800 - 110 - 60 - 70, 110, 60, 70]);
  });

  it("keeps values between the column's minimum and maximum", () => {
    expect(fitWidths([col(SHORT, 10), col(SHORT, 500)], 0)).toEqual([48, 120]);
  });

  it("sends the spare to Namespace and Node once Name is sized by the user", () => {
    const w = fitWidths([col(NAME, 200, 250), col(NS, 110), col(NS, 120), col(SHORT, 60)], 800);
    expect(w[0]).toBe(250);
    expect(w[3]).toBe(60);
    expect(sum(w)).toBe(800);
    expect(Math.abs(w[1] - 110 - (w[2] - 120))).toBeLessThanOrEqual(1);
  });

  it("takes a shortfall from other text first, then Namespace, Name last; short columns never", () => {
    const cols = [col(NAME, 300), col(NS, 200), col(TEXT, 200), col(SHORT, 60)];
    // 760 wanted; 100 short: all from the text column.
    expect(fitWidths(cols, 660)).toEqual([300, 200, 100, 60]);
    // 200 short: the text column to its minimum (128), then Namespace (72).
    expect(fitWidths(cols, 560)).toEqual([300, 128, 72, 60]);
    // Then Name, never the short column.
    const tight = fitWidths(cols, 300);
    expect(tight).toEqual([168, 96, 72, 60]);
    expect(sum(tight)).toBe(minTotal(cols));
  });

  it("cuts the widest of a tier first, to the same width", () => {
    const w = fitWidths([col(NAME, 168), col(NS, 300), col(NS, 120)], 168 + 300 + 120 - 100);
    expect(w).toEqual([168, 200, 120]);
    const both = fitWidths([col(NAME, 168), col(NS, 300), col(NS, 200)], 168 + 300);
    expect(both).toEqual([168, 150, 150]);
  });

  it("keeps a width the user set, even short of room", () => {
    expect(fitWidths([col(NAME, 300), col(TEXT, 200, 250)], 300)).toEqual([168, 250]);
  });

  it("leaves no spare to nobody when every growing column is sized by the user", () => {
    expect(fitWidths([col(NAME, 300, 300), col(SHORT, 60)], 800)).toEqual([300, 60]);
  });
});

describe("middleCut", () => {
  it("leaves a value that fits", () => {
    expect(middleCut("web-1", 100, mono)).toBe("web-1");
  });

  it("keeps a generated name's suffix, the part that tells pods apart", () => {
    const a = middleCut("payments-worker-canary-7d9f8b6c5-x7k2p", 20 * 7, mono);
    const b = middleCut("payments-worker-7d9f8b6c5-q2w3e", 20 * 7, mono);
    expect(mono(a)).toBeLessThanOrEqual(20 * 7);
    expect(a).toMatch(/^payments.*….*-x7k2p$/);
    expect(b).toMatch(/-q2w3e$/);
    expect(a).not.toBe(b);
  });

  it("cuts in the middle without a separator, and to nothing in no room", () => {
    const cut = middleCut("abcdefghijklmnopqrstuvwxyz", 10 * 7, mono);
    expect(cut).toHaveLength(10);
    expect(cut.startsWith("abcde")).toBe(true);
    expect(cut.endsWith("wxyz")).toBe(true);
    expect(middleCut("abcdef", 0, mono)).toBe("…");
  });
});

describe("settle, longest, sample", () => {
  it("keeps a width that narrows a little, takes one that grows or narrows a lot", () => {
    expect(settle([100, 100, 100], [92, 120, 60])).toEqual([100, 120, 60]);
    expect(settle(undefined, [1, 2])).toEqual([1, 2]);
  });

  it("picks the longest values", () => {
    expect(longest(["a", "abcd", "ab", "abc", "abcde"], 2)).toEqual(["abcde", "abcd"]);
    expect(longest(["x"], 3)).toEqual(["x"]);
  });

  it("samples big tables evenly, keeps small ones whole", () => {
    const big = Array.from({ length: 10_000 }, (_, i) => i);
    const s = sample(big, 100);
    expect(s).toHaveLength(100);
    expect(s[0]).toBe(0);
    expect(s[99]).toBe(9900);
    expect(sample([1, 2, 3], 100)).toEqual([1, 2, 3]);
  });
});
