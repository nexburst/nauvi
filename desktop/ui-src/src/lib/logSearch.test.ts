import { describe, expect, it } from "vitest";
import { compileQuery } from "./logFilter";
import { LOAD_PIECE, LogSearcher, SEARCH_CHUNK, SlowRegexError } from "./logSearch";
import type { SearchReply, SearchRequest, WorkerRequest } from "./logSearch";
import { LogBuffer } from "./logs";
import { Corpus } from "./logSearchCorpus";

const q = (text: string, regex = true, matchCase = false) => compileQuery({ text, regex, matchCase });

/** A stand-in Worker: answers like logSearch.worker.ts, or never (a regex that backtracks for ever). */
class FakeWorker {
  onmessage: ((e: MessageEvent<SearchReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  received: SearchRequest[] = [];
  /** Everything posted, corpus messages too. */
  all: WorkerRequest[] = [];
  corpus = new Corpus();
  constructor(private hang: (req: WorkerRequest) => boolean) {}
  postMessage(req: WorkerRequest) {
    this.all.push(req);
    if ("op" in req) {
      if (req.op === "load") this.corpus.load(req.first, req.lines.slice());
      else this.corpus.append(req.first, req.lines);
      return;
    }
    if ("items" in req) this.received.push(req);
    if (this.hang(req)) return;
    const re = new RegExp(req.source, req.flags);
    const f = (t: string) => (re.test(t) ? [0, 1] : null);
    const hits = "items" in req ? req.items.map(f) : this.corpus.map(req.from, req.to, f);
    queueMicrotask(() => this.onmessage?.({ data: { id: req.id, hits } } as MessageEvent<SearchReply>));
  }
  terminate() {
    this.terminated = true;
  }
}

function searcher(hang: (req: WorkerRequest) => boolean = () => false, timeout = 50) {
  const workers: FakeWorker[] = [];
  const s = new LogSearcher(timeout, () => {
    const w = new FakeWorker(hang);
    workers.push(w);
    return w as unknown as Worker;
  });
  return { s, workers };
}

describe("LogSearcher", () => {
  it("matches plain text on this thread, without a worker", async () => {
    const { s, workers } = searcher();
    expect(await s.run(q("err", false), ["an error", "ok"])).toEqual([[3, 6], null]);
    expect(workers).toHaveLength(0);
  });

  it("sends a regex to the worker in chunks, in order", async () => {
    const { s, workers } = searcher();
    const items = Array.from({ length: SEARCH_CHUNK * 2 + 5 }, (_, i) => (i % 2 ? "hit" : "miss"));
    const hits = await s.run(q("^hit$"), items);
    expect(hits).toHaveLength(items.length);
    expect(hits?.[1]).toEqual([0, 1]);
    expect(hits?.[2]).toBeNull();
    expect(workers).toHaveLength(1);
    expect(workers[0].received.map((r) => r.items.length)).toEqual([SEARCH_CHUNK, SEARCH_CHUNK, 5]);
  });

  it("stops a regex that takes too long and starts a fresh worker next time", async () => {
    // The fake worker never answers for "slow", like one stuck backtracking.
    const { s, workers } = searcher((req) => "source" in req && req.source === "slow");
    await expect(s.run(q("slow"), ["a line"])).rejects.toBeInstanceOf(SlowRegexError);
    expect(workers[0].terminated).toBe(true);
    expect(await s.run(q("a"), ["a"])).toEqual([[0, 1]]);
    expect(workers).toHaveLength(2);
  });

  it("gives up between chunks when the search is stale", async () => {
    const { s, workers } = searcher();
    const items = Array.from({ length: SEARCH_CHUNK * 3 }, () => "x");
    let calls = 0;
    expect(await s.run(q("x"), items, () => ++calls >= 1)).toBeNull();
    expect(workers[0].received).toHaveLength(1);
  });

  it("cancel rejects what runs, and is a no-op when idle", async () => {
    const { s, workers } = searcher(() => true, 10_000);
    s.cancel();
    expect(workers).toHaveLength(0);
    // Sent to the worker: it is stopped.
    const p = s.run(q("x"), ["x"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(workers).toHaveLength(1);
    s.cancel();
    await expect(p).rejects.toThrow("Search stopped");
    expect(workers[0].terminated).toBe(true);
    // Still waiting for its turn: never sent.
    const q2 = s.run(q("y"), ["y"]);
    s.cancel();
    await expect(q2).rejects.toThrow("Search stopped");
    expect(workers).toHaveLength(1);
  });

  it("runs the regex here when there are no workers", async () => {
    const s = new LogSearcher(50, null);
    expect(await s.run(q("b+"), ["abbc", "x"])).toEqual([[1, 3], null]);
  });
});

describe("LogSearcher over a corpus (#272)", () => {
  const collect = async (s: LogSearcher, query = q("hit"), from = 0, to = Infinity, buf?: LogBuffer) => {
    const out: (number[] | null)[] = [];
    const starts: number[] = [];
    const ok = await s.runRange(query, from, Math.min(to, buf?.end() ?? to), (start, hits) => {
      starts.push(start);
      out.push(...hits);
    });
    return { ok, out, starts };
  };

  it("sends the lines once, then only the new ones", async () => {
    const { s, workers } = searcher();
    const buf = new LogBuffer();
    s.attach(buf);
    buf.push(["hit", "miss"]);
    s.appended(["hit", "miss"]); // not loaded yet: nothing sent
    expect(workers).toHaveLength(0);
    let r = await collect(s, q("hit"), 0, Infinity, buf);
    expect(r.out).toEqual([[0, 1], null]);
    expect(workers[0].corpus.size).toBe(2);
    buf.push(["a hit"]);
    s.appended(["a hit"]);
    r = await collect(s, q("hit"), 2, Infinity, buf);
    expect(r.out).toEqual([[0, 1]]);
    // Only the new line went over, and the searches name ranges, not lines.
    expect(workers[0].all.filter((m) => "op" in m).map((m) => (m as { lines: string[] }).lines)).toEqual([[], ["hit", "miss"], ["a hit"]]);
    expect(workers[0].received).toHaveLength(0);
  });

  it("loads a big buffer a piece at a time, with the lines that come meanwhile", async () => {
    const { s, workers } = searcher();
    const buf = new LogBuffer();
    s.attach(buf);
    buf.push(Array.from({ length: LOAD_PIECE * 2 + 1 }, () => "miss"));
    const run = s.runRange(q("hit"), 0, buf.end(), () => {});
    // A task later the load is under way: these lines come with a later piece.
    await new Promise((r) => setTimeout(r, 0));
    buf.push(["hit", "hit"]);
    s.appended(["hit", "hit"]);
    await run;
    const pieces = workers[0].all.filter((m) => "op" in m).map((m) => (m as { lines: string[] }).lines.length);
    expect(pieces[0]).toBe(0);
    expect(Math.max(...pieces)).toBe(LOAD_PIECE);
    expect(pieces.reduce((a, b) => a + b, 0)).toBe(buf.lines.length);
    expect(workers[0].corpus.size).toBe(buf.lines.length);
    // Loaded: later lines go one batch at a time.
    buf.push(["x"]);
    s.appended(["x"]);
    expect(workers[0].corpus.size).toBe(buf.lines.length);
  });

  it("hands the hits over a chunk at a time, in order", async () => {
    const { s } = searcher();
    const buf = new LogBuffer();
    s.attach(buf);
    buf.push(Array.from({ length: SEARCH_CHUNK * 2 + 3 }, (_, i) => (i % 3 ? "miss" : "hit")));
    const r = await collect(s, q("hit"), 0, Infinity, buf);
    expect(r.starts).toEqual([0, SEARCH_CHUNK, SEARCH_CHUNK * 2]);
    expect(r.out).toHaveLength(buf.lines.length);
    expect(r.out.filter((h) => h).length).toBe(Math.ceil(buf.lines.length / 3));
  });

  it("keeps the worker's copy trimmed like the buffer", async () => {
    const { s, workers } = searcher();
    const buf = new LogBuffer();
    s.attach(buf);
    buf.push(["hit"]);
    await collect(s, q("hit"), 0, Infinity, buf);
    buf.clear();
    buf.push(["miss", "hit"]);
    s.appended(["miss", "hit"]);
    expect(workers[0].corpus.size).toBe(2);
    const r = await collect(s, q("hit"), buf.first(), Infinity, buf);
    expect(r.out).toEqual([null, [0, 1]]);
  });

  it("loads a fresh worker again after a slow regex", async () => {
    const { s, workers } = searcher((req) => "source" in req && req.source === "slow");
    const buf = new LogBuffer();
    s.attach(buf);
    buf.push(["hit"]);
    await expect(collect(s, q("slow"), 0, Infinity, buf)).rejects.toBeInstanceOf(SlowRegexError);
    const r = await collect(s, q("hit"), 0, Infinity, buf);
    expect(r.out).toEqual([[0, 1]]);
    expect(workers).toHaveLength(2);
    expect(workers[1].corpus.size).toBe(1);
  });

  it("runs one chunk at a time: a search after a slow one does not fail with it", async () => {
    const { s, workers } = searcher((req) => "source" in req && req.source === "slow");
    const buf = new LogBuffer();
    s.attach(buf);
    buf.push(["hit"]);
    const slow = collect(s, q("slow"), 0, Infinity, buf);
    const next = collect(s, q("hit"), 0, Infinity, buf);
    await expect(slow).rejects.toBeInstanceOf(SlowRegexError);
    expect((await next).out).toEqual([[0, 1]]);
    // It waited for the slow one to stop, then ran on a fresh worker.
    expect(workers).toHaveLength(2);
  });

  it("stops between chunks when stale, and matches text here", async () => {
    const { s, workers } = searcher();
    const buf = new LogBuffer();
    s.attach(buf);
    buf.push(Array.from({ length: SEARCH_CHUNK * 3 }, () => "x"));
    expect(await s.runRange(q("x"), 0, buf.end(), () => {}, () => true)).toBe(false);
    expect(workers[0].all.filter((m) => !("op" in m))).toHaveLength(1);
    const r = await collect(s, q("x", false), 0, 2, buf);
    expect(r.out).toEqual([[0, 1], [0, 1]]);
  });

  it("runs a range here when there are no workers, with trimmed lines as null", async () => {
    const s = new LogSearcher(50, null);
    const buf = new LogBuffer();
    s.attach(buf);
    buf.push(["a"]);
    buf.clear();
    buf.push(["ab"]);
    const r = await collect(s, q("b"), 0, 2, buf);
    expect(r.out).toEqual([null, [1, 2]]);
  });
});
