// The fitted columns of a resource table (#482): how wide each column is
// and what its cells show. Measures the shown rows' widest values (at most
// every FIT_MS, from a sample of big tables), then lays the columns out in
// the table's width with `fitWidths` (columnFit.ts). The table passes what
// it shows through `Source`; the layout is plain arithmetic on a resize.
import { untrack } from "svelte";
import { CELL_PAD, fitSettled, longest, middleCut, minTotal, sample, settle } from "../columnFit";
import type { FitInput, Measure } from "../columnFit";
import { cellWidth, STATUS_ICON_PX } from "../columns";
import type { Column, Ctx, Row } from "../columns";
import { cached, measurerFor } from "../textMeasure";

/** What the table shows, read when the widths are measured. */
export interface Source {
  columns(): Column[];
  rows(): readonly { row: Row }[];
  ctx(): Ctx;
  /** The sorted column's key: its header has room for the arrow. */
  sortKey(): string | undefined;
  /** Widths the user dragged columns to, by key. */
  userWidths(): Record<string, number | undefined>;
}

/** How often, at most, the widths follow the rows. */
const FIT_MS = 300;
/** The sort arrow and its gap. */
const ARROW_PX = 13;
export const MIN_DRAG = 40;
export const MAX_DRAG = 1200;

export class TableFit {
  /** The table's width for the columns, px. */
  avail = $state(0);
  /** The column being dragged, and to what width. */
  dragging = $state.raw<{ key: string; px: number } | null>(null);
  /** Widest value per column key, px with padding. */
  #naturals = $state.raw(new Map<string, number>());
  /** The same as last measured, before `settle` kept wider ones. */
  #measured = $state.raw(new Map<string, number>());
  /** Header label widths per column key, px with padding. */
  #heads = $state.raw(new Map<string, number>());
  #cell: Measure | null = null;
  #head: Measure | null = null;
  #at = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #rows = 0;
  /** A cut generated name keeps its end (`logger-84…-x7k2p`). */
  #middle = cached((text, width) => (this.#cell ? middleCut(text, width, this.#cell) : text));

  private readonly src: Source;

  constructor(src: Source) {
    this.src = src;
  }

  /** What a column's content asks for: its widest value or its header. */
  natural(key: string, measured = false): number | undefined {
    const cells = (measured ? this.#measured : this.#naturals).get(key);
    if (cells === undefined) return undefined;
    return Math.max(cells, (this.#heads.get(key) ?? 0) + (this.src.sortKey() === key ? ARROW_PX : 0));
  }

  #inputs(measured: boolean): FitInput[] {
    const user = this.src.userWidths();
    return this.src.columns().map((c) => ({
      fit: c.fit,
      natural: this.natural(c.key, measured) ?? c.fit.min,
      user: this.dragging?.key === c.key ? this.dragging.px : user[c.key],
    }));
  }
  readonly inputs: FitInput[] = $derived(this.#inputs(false));
  readonly #measuredInputs: FitInput[] = $derived(this.#inputs(true));
  /** Each column's width, px. */
  readonly widths: number[] = $derived(fitSettled(this.inputs, this.#measuredInputs, this.avail));
  /** The columns' width together: at least what their minimums need. */
  readonly total: number = $derived(
    Math.max(
      minTotal(this.inputs),
      this.widths.reduce((a, b) => a + b, 0),
    ),
  );
  /** The px left for a cell's text, per column. */
  readonly textWidths: number[] = $derived(
    this.widths.map((w, i) => w - CELL_PAD - (this.src.columns()[i]?.cls ? STATUS_ICON_PX : 0)),
  );

  /** Measure in the fonts of `grid` (cells) and its first header. */
  attach(grid: HTMLElement) {
    this.#cell = measurerFor(grid);
    this.#head = measurerFor(grid.querySelector("button.th") ?? grid);
    this.#middle.clear();
    this.measure();
  }

  /** The shown rows changed: measure now (new columns, first rows) or soon. */
  changed() {
    const cols = this.src.columns();
    const count = this.src.rows().length;
    const urgent = cols.some((c) => !this.#naturals.has(c.key)) || (this.#rows === 0 && count > 0);
    const wait = urgent ? 0 : Math.max(0, FIT_MS - (performance.now() - this.#at));
    if (wait === 0) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.measure();
    } else
      this.#timer ??= setTimeout(() => {
        this.#timer = undefined;
        this.measure();
      }, wait);
  }

  stop() {
    clearTimeout(this.#timer);
  }

  measure() {
    this.#at = performance.now();
    const cell = this.#cell;
    const head = this.#head;
    if (!cell || !head) return;
    untrack(() => {
      const entries = sample(this.src.rows());
      this.#rows = entries.length;
      const ctx = this.src.ctx();
      const next = new Map<string, number>();
      const heads = new Map<string, number>();
      for (const col of this.src.columns()) {
        heads.set(col.key, head(col.label) + CELL_PAD);
        let w = col.fit.sample ? CELL_PAD + cell(col.fit.sample) : 0;
        for (const t of longest(entries.map((e) => col.text(e.row, ctx)))) w = Math.max(w, cellWidth(col, t, cell));
        next.set(col.key, Math.ceil(w));
      }
      // A column narrowing a little keeps its width (no jitter).
      const keys = [...next.keys()];
      const kept = settle(
        keys.map((k) => this.#naturals.get(k) ?? 0),
        keys.map((k) => next.get(k)!),
      );
      this.#naturals = new Map(keys.map((k, i) => [k, kept[i]]));
      this.#measured = next;
      this.#heads = heads;
    });
  }

  /** What cell `text` of column `i` shows, and whether that is all of it. */
  shown(i: number, text: string): { text: string; cut: boolean } {
    const room = this.textWidths[i];
    const cell = this.#cell;
    if (!cell || room === undefined || !text) return { text, cut: false };
    if (this.src.columns()[i]?.fit.middle) {
      const shown = this.#middle(text, room);
      return { text: shown, cut: shown !== text };
    }
    return { text, cut: cell(text) > room };
  }
}
