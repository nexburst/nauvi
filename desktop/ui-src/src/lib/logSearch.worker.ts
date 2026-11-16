// Runs the log viewer's regex (#220) off the UI thread: a catastrophic
// pattern such as `(a+)+$` can backtrack for minutes, and only a worker can
// be stopped (terminated) while it does.

import { regexRanges } from "./logFilter";
import type { SearchReply, SearchRequest } from "./logSearch";

let cached: { key: string; re: RegExp } | null = null;

self.onmessage = (e: MessageEvent<SearchRequest>) => {
  const { id, source, flags, items } = e.data;
  let reply: SearchReply;
  try {
    const key = flags + "/" + source;
    if (cached?.key !== key) cached = { key, re: new RegExp(source, flags) };
    const re = cached.re;
    reply = { id, hits: items.map((t) => regexRanges(re, t)) };
  } catch (err) {
    reply = { id, error: String(err) };
  }
  (self as unknown as Worker).postMessage(reply);
};
