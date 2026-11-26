/** A row and its key. What a table's filter matches is the table's
 *  business: it depends on the shown columns (#512, `shownText`). */
export interface Entry<T> {
  key: string;
  row: T;
}

export interface BatchLike<T> {
  /**
   * When true, `applied` is the full state of the batch's source (watch) and
   * any row of that source not in it is gone. Other sources' rows stay.
   */
  snapshot: boolean;
  applied: T[];
  /** Keys of removed rows. */
  deleted: string[];
}

/**
 * Keyed rows updated by watch batches.
 *
 * The rows live in a plain `Map` and are republished as one `$state.raw`
 * array per batch. Deep `$state` would wrap every row in a proxy, which is
 * wasteful at 5-10k rows; here a batch costs one array rebuild and every row
 * object is replaced, never mutated.
 *
 * Several watches (one per namespace) can feed one store: each batch names
 * its source, and a snapshot or `removeSource` only touches that source's
 * rows. Callers with a single watch can ignore sources.
 */
export class KeyedStore<T extends object> {
  #map = new Map<string, Entry<T>>();
  /** The source of each row, by key. */
  #sourceOf = new Map<string, string>();
  #keyOf: (row: T) => string;

  /** All rows in insertion order; replaced (not mutated) on every change. */
  entries = $state.raw<Entry<T>[]>([]);

  constructor(keyOf: (row: T) => string) {
    this.#keyOf = keyOf;
  }

  get size(): number {
    return this.#map.size;
  }

  clear() {
    this.#map.clear();
    this.#sourceOf.clear();
    this.entries = [];
  }

  /** Apply one batch from `source` and publish the result once. */
  applyBatch(batch: BatchLike<T>, source = "") {
    if (batch.snapshot) {
      const keep = new Set<string>();
      for (const row of batch.applied) keep.add(this.#keyOf(row));
      for (const [key, from] of this.#sourceOf) if (from === source && !keep.has(key)) this.#delete(key);
    }
    for (const row of batch.applied) {
      const key = this.#keyOf(row);
      this.#map.set(key, { key, row });
      this.#sourceOf.set(key, source);
    }
    for (const key of batch.deleted) this.#delete(key);
    this.entries = [...this.#map.values()];
  }

  /** Drop every row of `source` (a stopped watch) and publish. */
  removeSource(source: string) {
    let changed = false;
    for (const [key, from] of this.#sourceOf) {
      if (from === source) {
        this.#delete(key);
        changed = true;
      }
    }
    if (changed) this.entries = [...this.#map.values()];
  }

  #delete(key: string) {
    this.#map.delete(key);
    this.#sourceOf.delete(key);
  }
}
