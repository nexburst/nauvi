// The search worker's copy of the log lines (#272), by sequence number:
// loaded once, then appended to and trimmed at the start like the viewer's
// buffer.

import type { Hits } from "./logSearch";

export class Corpus {
  private lines: string[] = [];
  /** Sequence number of `lines[0]`. */
  private base = 0;

  load(first: number, lines: string[]) {
    this.lines = lines;
    this.base = first;
  }

  append(first: number, lines: string[]) {
    for (const l of lines) this.lines.push(l);
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
      const t = this.lines[s - this.base];
      out[s - from] = t === undefined ? null : f(t);
    }
    return out;
  }

  get size() {
    return this.lines.length;
  }
}
