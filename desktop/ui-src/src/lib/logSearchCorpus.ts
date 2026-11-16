// The search worker's copy of the log lines (#272), by sequence number:
// loaded once, then appended to and trimmed at the start like the viewer's
// buffer.

import type { Hits } from "./logSearch";

export class Corpus {
  private lines: string[] = [];
  /** Sequence number of `lines[0]`. */
  private base = 0;

  /** Empty it; the next lines are numbered from `at`. */
  load(at: number) {
    this.lines = [];
    this.base = at;
  }

  /**
   * Add `lines`, numbered from `at`, then drop those before `first`. A gap
   * (lines trimmed before they were sent) starts over at `at`; lines held
   * already are not added twice.
   */
  append(at: number, first: number, lines: string[]) {
    let end = this.base + this.lines.length;
    if (at > end) {
      this.lines = [];
      this.base = end = at;
    }
    for (let k = Math.max(0, end - at); k < lines.length; k++) this.lines.push(lines[k]);
    this.dropBefore(first);
  }

  private dropBefore(first: number) {
    if (first <= this.base) return;
    const n = first - this.base;
    if (n >= this.lines.length) this.lines = [];
    else this.lines.splice(0, n);
    this.base = first;
  }

  /** `f` of each line `from` up to `to`; null for one not held (trimmed). */
  map(from: number, to: number, f: (t: string) => Hits): Hits[] {
    const out: Hits[] = new Array(Math.max(0, to - from));
    for (let s = from; s < to; s++) {
      const t = s >= this.base ? this.lines[s - this.base] : undefined;
      out[s - from] = t === undefined ? null : f(t);
    }
    return out;
  }

  get size() {
    return this.lines.length;
  }
}
