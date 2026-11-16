// Matches log lines against a query (#220). Plain text is matched here;
// a regex runs in a worker with a time limit per chunk of lines, so a
// pattern that backtracks without end stops the search, not the app.

import { regexRanges, textRanges } from "./logFilter";
import type { CompiledQuery } from "./logFilter";

/** Ranges per line (see `regexRanges`), null for a line that does not match. */
export type Hits = number[] | null;

export interface SearchRequest {
  id: number;
  source: string;
  flags: string;
  items: string[];
}

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

/** Makes the worker; replaced in tests. */
export type WorkerFactory = () => Worker;

const defaultWorker: WorkerFactory = () =>
  new Worker(new URL("./logSearch.worker.ts", import.meta.url), { type: "module" });

type Waiter = { resolve: (h: Hits[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class LogSearcher {
  private worker: Worker | null = null;
  private nextId = 0;
  private waiting = new Map<number, Waiter>();

  constructor(
    private timeoutMs = SEARCH_TIMEOUT_MS,
    private makeWorker: WorkerFactory | null = typeof Worker === "undefined" ? null : defaultWorker,
  ) {}

  /**
   * The hits of each of `items`. `stale()` is checked between chunks: when
   * it says true the search stops and resolves to null (a newer one runs).
   * Rejects with `SlowRegexError` when a chunk takes over the time limit.
   */
  async run(q: CompiledQuery, items: string[], stale: () => boolean = () => false): Promise<Hits[] | null> {
    if (q.kind === "text") return items.map((t) => textRanges(t, q.needle, q.matchCase));
    if (q.kind !== "regex") return items.map(() => null);
    const out: Hits[] = [];
    for (let i = 0; i < items.length; i += SEARCH_CHUNK) {
      const hits = await this.chunk(q.source, q.flags, items.slice(i, i + SEARCH_CHUNK));
      if (stale()) return null;
      for (const h of hits) out.push(h);
    }
    return out;
  }

  private chunk(source: string, flags: string, items: string[]): Promise<Hits[]> {
    const worker = this.ensureWorker();
    if (!worker) {
      // No workers (unit tests): run it here, without a time limit.
      const re = new RegExp(source, flags);
      return Promise.resolve(items.map((t) => regexRanges(re, t)));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new SlowRegexError(this.timeoutMs)), this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      worker.postMessage({ id, source, flags, items } satisfies SearchRequest);
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
    return worker;
  }

  /** Abandon a search in progress (its `run` rejects); a no-op when idle. */
  cancel() {
    if (this.waiting.size > 0) this.stop();
  }

  /** Stop the worker (a fresh one starts with the next search) and fail what waits. */
  stop(reason: Error = new Error("Search stopped")) {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(reason);
    }
    this.waiting.clear();
  }
}
