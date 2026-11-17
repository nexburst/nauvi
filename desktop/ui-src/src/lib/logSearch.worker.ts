// Runs the log viewer's regex (#220) off the UI thread: a catastrophic
// pattern such as `(a+)+$` can backtrack for minutes, and only a worker can
// be stopped (terminated) while it does. It keeps its own copy of the log
// lines (#272), sent once and then appended to, so a search only names a range.

import { regexRanges, testHit } from "./logFilter";
import type { Hits, SearchReply, WorkerRequest } from "./logSearch";
import { Corpus } from "./logSearchCorpus";

// Two: the search and the exclude pattern (#339) take turns, chunk by chunk.
const cached = new Map<string, RegExp>();
const corpus = new Corpus();

function regex(source: string, flags: string): RegExp {
  const key = flags + "/" + source;
  let re = cached.get(key);
  if (!re) {
    if (cached.size >= 2) cached.delete(cached.keys().next().value as string);
    cached.set(key, (re = new RegExp(source, flags)));
  }
  return re;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if ("op" in req) {
    if (req.op === "load") corpus.load(req.at);
    corpus.append(req.at, req.first, req.lines);
    return;
  }
  let reply: SearchReply;
  try {
    const re = regex(req.source, req.flags);
    let hits: Hits[];
    if ("items" in req) hits = req.items.map((t) => (req.test ? testHit(re, t) : regexRanges(re, t)));
    else hits = corpus.map(req.from, req.to, (t) => regexRanges(re, t));
    reply = { id: req.id, hits };
  } catch (err) {
    reply = { id: req.id, error: String(err) };
  }
  (self as unknown as Worker).postMessage(reply);
};
