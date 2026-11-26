// Fitted table columns (#482): each column is as wide as its widest value
// (and its header), the spare width goes to Name first, and when the table
// is short of room the long text columns give way, Name last. What the
// user dragged a column to wins over all of that.
//
// Pure: the text is measured by a function the caller passes (a canvas in
// the app, a fixed width per character in the tests).

/** How a column's width is fitted. Widths are px, cell padding included. */
export interface Fit {
  /** The narrowest it gets when the table is short of room (a column
   *  whose values are narrower stays as narrow as they are). */
  min: number;
  /** The widest its content makes it (the spare width can go beyond). */
  max: number;
  /** Takes the spare width; the highest takes all of it. 0: never. */
  grow: number;
  /** Gives up width below its content's when the table is short of room,
   *  the lowest first. 0: never (short values: Ready, Age, Status). */
  give: number;
  /** A cut value keeps its end, where generated names differ
   *  (`logger-846dd6…-x7k2p`), instead of losing it to an ellipsis. */
  middle?: boolean;
  /** A value at least this wide is expected (Age's `9m59s`), so the
   *  column does not widen and narrow as values change. */
  sample?: string;
}

/** The horizontal padding of a cell (8 px each side). */
export const CELL_PAD = 16;

/** A column's input to `fitWidths`. */
export interface FitInput {
  fit: Fit;
  /** Its widest value or header, px with padding (see `naturalWidth`). */
  natural: number;
  /** The width the user dragged it to, if any. */
  user?: number;
}

/** The width a column's content asks for: its widest value or its header,
 *  up to its maximum. (Its minimum is how far it gives way, not a width
 *  it takes: a Name column of short names stays narrow, and the spare
 *  width it gets is what is left over.) */
export function wanted(c: FitInput): number {
  if (c.user !== undefined) return c.user;
  return Math.round(Math.min(c.fit.max, c.natural));
}

/** The narrowest the columns get together: a table narrower than this
 *  scrolls sideways instead of cutting values further. */
export function minTotal(cols: readonly FitInput[]): number {
  return cols.reduce((sum, c) => sum + (c.user === undefined && c.fit.give > 0 ? Math.min(c.fit.min, wanted(c)) : wanted(c)), 0);
}

/**
 * The widths of `cols` in `avail` px. Each starts at what its content
 * wants. Spare width goes to the columns of the highest `grow`; a shortfall
 * is taken from the columns of the lowest `give` first, the widest first
 * (they are cut to the same width, never below their minimum), so short
 * columns and Name keep their values longest. What the user set is kept.
 */
export function fitWidths(cols: readonly FitInput[], avail: number): number[] {
  const w = cols.map(wanted);
  let spare = Math.floor(avail) - w.reduce((a, b) => a + b, 0);
  if (spare > 0) {
    const free = cols.map((c, i) => (c.user === undefined ? i : -1)).filter((i) => i >= 0);
    const top = Math.max(0, ...free.map((i) => cols[i].fit.grow));
    const takers = free.filter((i) => top > 0 && cols[i].fit.grow === top);
    takers.forEach((i, n) => {
      // Whole pixels; the first takers get the remainder.
      w[i] += Math.floor(spare / takers.length) + (n < spare % takers.length ? 1 : 0);
    });
    return w;
  }
  const tiers = [...new Set(cols.map((c) => c.fit.give).filter((g) => g > 0))].sort((a, b) => a - b);
  for (const tier of tiers) {
    if (spare >= 0) break;
    const at = cols.map((c, i) => (c.user === undefined && c.fit.give === tier ? i : -1)).filter((i) => i >= 0);
    spare += cut(w, at, (i) => Math.min(cols[i].fit.min, w[i]), -spare);
  }
  return w;
}

/** Narrows the columns `at` of `w` by up to `need` px in all, the widest
 *  first, down to the same level, none below `floor(i)`. Returns how much
 *  it took. */
function cut(w: number[], at: number[], floor: (i: number) => number, need: number): number {
  const room = (level: number) => at.reduce((sum, i) => sum + Math.max(0, w[i] - Math.max(floor(i), level)), 0);
  if (at.length === 0 || need <= 0) return 0;
  // The highest level that frees enough (or 0: all of them to their floor).
  let lo = 0;
  let hi = Math.max(...at.map((i) => w[i]));
  if (room(0) <= need) lo = 0;
  else {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (room(mid) >= need) lo = mid;
      else hi = mid;
    }
  }
  let took = 0;
  for (const i of at) {
    const to = Math.max(floor(i), Math.min(w[i], lo));
    took += w[i] - to;
    w[i] = to;
  }
  return took;
}

/** The longest last part (`-x7k2p`) kept whole by `middleCut`. */
const MAX_SUFFIX = 12;

/** Text width, px. */
export type Measure = (text: string) => number;

/**
 * `text` cut to fit `width` px, with the ellipsis in the middle: the start
 * and the end stay, and the end keeps the last part after a `-`, `.` or
 * `/` when there is room for it (a pod's random suffix). The text itself
 * when it fits.
 */
export function middleCut(text: string, width: number, measure: Measure): string {
  if (measure(text) <= width) return text;
  const last = Math.max(text.lastIndexOf("-"), text.lastIndexOf("."), text.lastIndexOf("/"));
  const suffix = last > 0 ? text.length - last : 0;
  const make = (k: number) => {
    // A short last part (a pod's `-x7k2p`, a namespace's `-payments`) whole,
    // with all the rest of the room for the start: what is cut is the
    // middle, the ReplicaSet hash first. Otherwise a little less than half.
    const tail = suffix > 0 && suffix <= MAX_SUFFIX && suffix <= k - 4 ? suffix : Math.floor(k * 0.45);
    return text.slice(0, k - tail) + "…" + (tail > 0 ? text.slice(-tail) : "");
  };
  // The most characters that fit.
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(make(mid)) <= width) lo = mid;
    else hi = mid - 1;
  }
  return make(lo);
}

/** Widths that changed by less than this stay as they were, so a table
 *  does not jitter as its values change (an age ticking up a character). */
export const SETTLE_PX = 16;

/** `next`, except that a column narrowing by less than `SETTLE_PX` keeps
 *  its width from `prev`. */
export function settle(prev: readonly number[] | undefined, next: number[]): number[] {
  if (!prev || prev.length !== next.length) return next;
  return next.map((n, i) => (n < prev[i] && prev[i] - n < SETTLE_PX ? prev[i] : n));
}

/**
 * `fitWidths` of the settled inputs (widths kept by `settle`) while they fit
 * in `avail`; when the table is short of room, of the measured ones: a
 * width kept for a value no longer shown never cuts another column's
 * values (a pod name cut while CPU keeps the room of a value gone with an
 * earlier filter). `settled` and `measured` list the same columns.
 */
export function fitSettled(settled: readonly FitInput[], measured: readonly FitInput[], avail: number): number[] {
  const want = settled.reduce((sum, c) => sum + wanted(c), 0);
  return fitWidths(want <= Math.floor(avail) ? settled : measured, avail);
}

/** The values to measure of a column: at most `n`, the longest by length
 *  (a proportional font keeps the order close enough). */
export function longest(values: Iterable<string>, n = 12): string[] {
  const top: string[] = [];
  for (const v of values) {
    if (top.length < n) {
      top.push(v);
      if (top.length === n) top.sort((a, b) => b.length - a.length);
    } else if (v.length > top[n - 1].length) {
      top[n - 1] = v;
      for (let i = n - 1; i > 0 && top[i].length > top[i - 1].length; i--) [top[i], top[i - 1]] = [top[i - 1], top[i]];
    }
  }
  return top;
}

/** Rows to look at for the widths: all of them up to `max`, else an even
 *  sample (a table of 10 000 pods is measured in about the same time as one
 *  of 1 000). */
export function sample<T>(items: readonly T[], max = 1000): T[] {
  if (items.length <= max) return items as T[];
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]);
}
