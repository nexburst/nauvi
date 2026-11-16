// Matches log lines against a query (#220). Plain text is matched here;
// a regex runs in a worker with a time limit per chunk of lines, so a
// pattern that backtracks without end stops the search, not the app.
//
// The log viewer's lines are sent to the worker once and kept up to date
// there (a corpus, by sequence number, #272): a search then only names the
// range to search, instead of copying 50,000 lines each time.

import { regexRanges, testHit, textRanges } from "./logFilter";
import type { CompiledQuery } from "./logFilter";

/** Ranges per line (see `regexRanges`), null for a line that does not match. */
export type Hits = number[] | null;

export interface SearchRequest {
  id: number;
  source: string;
  flags: string;
  items: string[];
  /** Only whether each item matches (the table filter, #219): `[]` or null. */
  test?: boolean;
}

/** Search the corpus lines with sequence numbers `from` up to `to`. */
export interface RangeRequest {
  id: number;
  source: string;
  flags: string;
  from: number;
  to: number;
}

/**
 * Changes to the worker's copy of the lines: `load` replaces it, `append`
 * adds lines at the end. Both drop the lines before `first` (trimmed).
 */
export interface CorpusMessage {
  op: "load" | "append";
  first: number;
  lines: string[];
}

export type WorkerRequest = SearchRequest | RangeRequest | CorpusMessage;

export type SearchReply = { id: number; hits: Hits[] } | { id: number; error: string };

/** Lines per message to the worker, each with its own time limit. */
export const SEARCH_CHUNK = 2000;
/** How long one chunk may take before the regex counts as too slow. */
export const SEARCH_TIMEOUT_MS = 1500;

/** The regex took longer than the limit; the worker was stopped. */
export class SlowRegexError extends Error {
  constructor(ms: number) {
    super(`Regex too slow: stopped after ${ms / 1000} s on one chunk of lines; try a simpler one`);
    this.name = "SlowRegexError";
  }
}

/** The lines a corpus search reads, by sequence number (numbers only grow). */
export interface CorpusSource {
  /** Sequence number of the oldest line kept. */
  first(): number;
  /** Sequence number after the newest line. */
  end(): number;
  /** The lines `from` up to `to` (clamped to first..end). */
  slice(from: number, to: number): string[];
}

/** Makes the worker; replaced in tests. */
export type WorkerFactory = () => Worker;

const defaultWorker: WorkerFactory = () =>
  new Worker(new URL("./logSearch.worker.ts", import.meta.url), { type: "module" });

type Waiter = { resolve: (h: Hits[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class LogSearcher {
  private worker: Worker | null = null;
  private nextId = 0;
  private waiting = new Map<number, Waiter>();
  /** Settles when the chunk the worker runs now is done: one at a time. */
  private idle: Promise<void> = Promise.resolve();
  /** Bumped by `cancel`: chunks queued before it are not sent. */
  private epoch = 0;
  private corpus: CorpusSource | null = null;
  /** Whether the worker holds `corpus` (loaded by the first range search). */
  private synced = false;

  constructor(
    private timeoutMs = SEARCH_TIMEOUT_MS,
    private makeWorker: WorkerFactory | null = typeof Worker === "undefined" ? null : defaultWorker,
  ) {}

  /**
   * The hits of each of `items`. `stale()` is checked between chunks: when
   * it says true the search stops and resolves to null (a newer one runs).
   * Rejects with `SlowRegexError` when a chunk takes over the time limit.
   */
  async run(
    q: CompiledQuery,
    items: string[],
    stale: () => boolean = () => false,
    test = false,
  ): Promise<Hits[] | null> {
    if (q.kind === "text") return items.map((t) => textRanges(t, q.needle, q.matchCase));
    if (q.kind !== "regex") return items.map(() => null);
    const out: Hits[] = [];
    for (let i = 0; i < items.length; i += SEARCH_CHUNK) {
      const hits = await this.chunk(q.source, q.flags, items.slice(i, i + SEARCH_CHUNK), test);
      if (stale()) return null;
      for (const h of hits) out.push(h);
    }
    return out;
  }

  /** Search the lines of `source` by sequence number (`runRange`). */
  attach(source: CorpusSource) {
    this.corpus = source;
    this.synced = false;
  }

  /**
   * Lines were added at the end of the corpus (and maybe trimmed at its
   * start). Once the worker holds the corpus, only these are sent.
   */
  appended(lines: string[]) {
    if (!this.synced || !this.worker || !this.corpus || lines.length === 0) return;
    this.worker.postMessage({ op: "append", first: this.corpus.first(), lines } satisfies CorpusMessage);
  }

  /**
   * The hits of the corpus lines `from` up to `to`, a chunk at a time:
   * `onChunk(start, hits)` gets each chunk as it comes (`start`: the
   * sequence number of its first line), so the caller builds its result
   * incrementally. A line trimmed meanwhile has null hits. Resolves to
   * false when `stale()` said to stop; rejects like `run`.
   */
  async runRange(
    q: CompiledQuery,
    from: number,
    to: number,
    onChunk: (start: number, hits: Hits[]) => void,
    stale: () => boolean = () => false,
  ): Promise<boolean> {
    const src = this.corpus;
    if (!src) throw new Error("No lines to search");
    for (let i = from; i < to; i += SEARCH_CHUNK) {
      const end = Math.min(to, i + SEARCH_CHUNK);
      let hits: Hits[];
      if (q.kind === "regex") hits = await this.rangeChunk(src, q.source, q.flags, i, end);
      else if (q.kind === "text") hits = src.slice(i, end).map((t) => textRanges(t, q.needle, q.matchCase));
      else hits = new Array<Hits>(end - i).fill(null);
      if (stale()) return false;
      onChunk(i, hits);
    }
    return true;
  }

  private rangeChunk(src: CorpusSource, source: string, flags: string, from: number, to: number): Promise<Hits[]> {
    return this.serial(() => this.sendRange(src, source, flags, from, to));
  }

  private sendRange(src: CorpusSource, source: string, flags: string, from: number, to: number): Promise<Hits[]> {
    const worker = this.ensureWorker();
    if (!worker) {
      // No workers (unit tests): run it here, without a time limit.
      const re = new RegExp(source, flags);
      const lines = src.slice(from, to);
      const pad = to - from - lines.length;
      return Promise.resolve(new Array<Hits>(pad).fill(null).concat(lines.map((t) => regexRanges(re, t))));
    }
    if (!this.synced) {
      // The one copy of the lines; after it, only new ones (`appended`).
      const first = src.first();
      worker.postMessage({ op: "load", first, lines: src.slice(first, src.end()) } satisfies CorpusMessage);
      this.synced = true;
    }
    return this.post(worker, { id: ++this.nextId, source, flags, from, to });
  }

  private chunk(source: string, flags: string, items: string[], test: boolean): Promise<Hits[]> {
    return this.serial(() => {
      const worker = this.ensureWorker();
      if (!worker) {
        const re = new RegExp(source, flags);
        return Promise.resolve(items.map((t) => (test ? testHit(re, t) : regexRanges(re, t))));
      }
      return this.post(worker, { id: ++this.nextId, source, flags, items, test });
    });
  }

  /**
   * Run `send` once the chunk before it has settled: one chunk at a time,
   * so each time limit only counts its own chunk. A `cancel` meanwhile
   * stops the ones still waiting.
   */
  private serial(send: () => Promise<Hits[]>): Promise<Hits[]> {
    const epoch = this.epoch;
    const run = this.idle.then(() => (epoch === this.epoch ? send() : Promise.reject(new Error("Search stopped"))));
    this.idle = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Send one chunk with its time limit. */
  private post(worker: Worker, req: SearchRequest | RangeRequest): Promise<Hits[]> {
    return new Promise<Hits[]>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new SlowRegexError(this.timeoutMs)), this.timeoutMs);
      this.waiting.set(req.id, { resolve, reject, timer });
      worker.postMessage(req satisfies WorkerRequest);
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (!this.makeWorker) return null;
    let worker: Worker;
    try {
      worker = this.makeWorker();
    } catch {
      this.makeWorker = null;
      return null;
    }
    worker.onmessage = (e: MessageEvent<SearchReply>) => {
      const w = this.waiting.get(e.data.id);
      if (!w) return;
      this.waiting.delete(e.data.id);
      clearTimeout(w.timer);
      if ("error" in e.data) w.reject(new Error(e.data.error));
      else w.resolve(e.data.hits);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      this.stop(new Error(e.message || "The search worker failed"));
    };
    this.worker = worker;
    this.synced = false;
    return worker;
  }

  /** Abandon a search in progress (its `run` rejects); a no-op when idle. */
  cancel() {
    this.epoch++;
    if (this.waiting.size > 0) this.stop();
  }

  /** Stop the worker (a fresh one starts with the next search) and fail what waits. */
  stop(reason: Error = new Error("Search stopped")) {
    this.worker?.terminate();
    this.worker = null;
    this.synced = false;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(reason);
    }
    this.waiting.clear();
  }
}
