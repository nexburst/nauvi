import { describe, expect, it } from "vitest";
import { compileQuery } from "./logFilter";
import { LogSearcher, SEARCH_CHUNK, SlowRegexError } from "./logSearch";
import type { SearchReply, SearchRequest } from "./logSearch";

const q = (text: string, regex = true, matchCase = false) => compileQuery({ text, regex, matchCase });

/** A stand-in Worker: answers like logSearch.worker.ts, or never (a regex that backtracks forever). */
class FakeWorker {
  onmessage: ((e: MessageEvent<SearchReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  received: SearchRequest[] = [];
  constructor(private hang: (req: SearchRequest) => boolean) {}
  postMessage(req: SearchRequest) {
    this.received.push(req);
    if (this.hang(req)) return;
    const re = new RegExp(req.source, req.flags);
    const hits = req.items.map((t) => (re.test(t) ? [0, 1] : null));
    queueMicrotask(() => this.onmessage?.({ data: { id: req.id, hits } } as MessageEvent<SearchReply>));
  }
  terminate() {
    this.terminated = true;
  }
}

function searcher(hang: (req: SearchRequest) => boolean = () => false, timeout = 50) {
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
    const { s, workers } = searcher((req) => req.source === "(a+)+$");
    await expect(s.run(q("(a+)+$"), ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"])).rejects.toBeInstanceOf(SlowRegexError);
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
    const p = s.run(q("x"), ["x"]);
    s.cancel();
    await expect(p).rejects.toThrow("Search stopped");
    expect(workers[0].terminated).toBe(true);
  });

  it("runs the regex here when there are no workers", async () => {
    const s = new LogSearcher(50, null);
    expect(await s.run(q("b+"), ["abbc", "x"])).toEqual([[1, 3], null]);
  });
});
