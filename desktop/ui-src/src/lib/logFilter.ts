// The log viewer's search (#220): plain text or regex, match case or not,
// filter or highlight, and "Jump to time". Pure functions; the regex itself
// runs in a worker (logSearch.ts), never on the UI thread.

/** What the user typed in the search box, and the two toggles. */
export interface LogQuery {
  text: string;
  regex: boolean;
  matchCase: boolean;
}

/** A query ready to run, or why it cannot. */
export type CompiledQuery =
  | { kind: "none" }
  | { kind: "text"; needle: string; matchCase: boolean }
  | { kind: "regex"; source: string; flags: string }
  | { kind: "error"; message: string };

/** At most this many highlighted ranges per line (a `.` regex on a long line). */
export const MAX_HITS_PER_LINE = 200;

/** Check a query; an invalid regex says why, in the engine's words. */
export function compileQuery(q: LogQuery): CompiledQuery {
  if (!q.text) return { kind: "none" };
  if (!q.regex) return { kind: "text", needle: q.matchCase ? q.text : q.text.toLowerCase(), matchCase: q.matchCase };
  const flags = q.matchCase ? "g" : "gi";
  try {
    new RegExp(q.text, flags);
  } catch (e) {
    return { kind: "error", message: invalidRegexMessage(e) };
  }
  return { kind: "regex", source: q.text, flags };
}

/**
 * The engine's reason without its preamble: V8 says "Invalid regular
 * expression: /(a/gi: Unterminated group", JavaScriptCore (WebKit) "Invalid
 * regular expression: missing )".
 */
export function invalidRegexMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/^Invalid regular expression: (?:\/.*\/[a-z]*: )?(.+)$/s);
  return m ? m[1] : msg;
}

/**
 * The ranges of `text` that match, as flat [start, end, start, end, ...]
 * pairs, or null when the line does not match. A line that only matches an
 * empty string (`^`, `x*`) matches with no ranges, like grep.
 */
export function regexRanges(re: RegExp, text: string, max = MAX_HITS_PER_LINE): number[] | null {
  re.lastIndex = 0;
  let out: number[] | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out ??= [];
    const end = m.index + m[0].length;
    if (end === m.index) {
      // Step over an empty match, by code point so "u" regexes stay valid.
      re.lastIndex = m.index + ((text.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1);
      if (m.index >= text.length) break;
      continue;
    }
    out.push(m.index, end);
    if (out.length >= max * 2) break;
  }
  return out;
}

/** `[]` when `re` matches `text` anywhere, else null: the table filter (#219) needs no ranges. */
export function testHit(re: RegExp, text: string): number[] | null {
  re.lastIndex = 0;
  return re.test(text) ? [] : null;
}

/** Substring ranges; `needle` is lower-case already unless `matchCase`. */
export function textRanges(text: string, needle: string, matchCase: boolean, max = MAX_HITS_PER_LINE): number[] | null {
  if (!needle) return null;
  const hay = matchCase ? text : text.toLowerCase();
  let i = hay.indexOf(needle);
  if (i < 0) return null;
  const out: number[] = [];
  // toLowerCase keeps the length for all but a few scripts; clamp anyway.
  while (i >= 0 && out.length < max * 2) {
    out.push(i, Math.min(i + needle.length, text.length));
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Split `text` at the ranges from `regexRanges`/`textRanges`. */
export function segments(text: string, ranges: readonly number[] | null | undefined): Segment[] {
  if (!ranges || ranges.length === 0) return [{ text, hit: false }];
  const out: Segment[] = [];
  let pos = 0;
  for (let k = 0; k < ranges.length; k += 2) {
    const start = Math.max(ranges[k], pos);
    const end = ranges[k + 1];
    if (end <= start) continue;
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    pos = end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** "3 of 120", "120 matches" (none current yet), "No matches", or "". */
export function matchCountLabel(active: boolean, current: number, count: number): string {
  if (!active) return "";
  if (count === 0) return "No matches";
  if (current < 0) return `${count.toLocaleString()} ${count === 1 ? "match" : "matches"}`;
  return `${(current + 1).toLocaleString()} of ${count.toLocaleString()}`;
}

/**
 * The next (or previous) match after the current one, wrapping around.
 * `matches` are sorted ids of matching lines; `current` is the id of the
 * current one or -1. Without a current match: from `fromId` (the first line
 * in view) when given, else the last match going back / first going forward.
 * Returns the position in `matches`, or -1 when there are none.
 */
export function stepMatch(matches: readonly number[], current: number, forward: boolean, fromId = -1): number {
  const n = matches.length;
  if (n === 0) return -1;
  const at = current >= 0 ? current : fromId;
  if (at < 0) return forward ? 0 : n - 1;
  // First position with id > at (forward) or the last with id < at (back).
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (forward ? matches[mid] <= at : matches[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  if (forward) return lo < n ? lo : 0;
  // Without a current match, a match at `fromId` itself counts going back.
  if (current < 0 && lo < n && matches[lo] === at) return lo;
  return lo > 0 ? lo - 1 : n - 1;
}

/** The index of `id` in sorted `ids`, or -1. */
export function indexOfId(ids: readonly number[], id: number): number {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] === id) return mid;
    if (ids[mid] < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// ---- Jump to time ----

const LINE_TIME = /^\s*\[?(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d\d:?\d\d)?/i;

/**
 * The time at the start of a log line, in ms since the epoch: the RFC 3339
 * stamp `--timestamps` adds (`2026-11-16T10:00:00.123456789Z`), or an
 * application's own `2026-11-16 10:00:00,123` (local time without a zone).
 * NaN when the line does not start with one.
 */
export function lineTime(line: string): number {
  const m = LINE_TIME.exec(line);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = "0", frac = "0", zone] = m;
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  const fields = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms] as const;
  if (!zone) return new Date(...fields).getTime();
  const utc = Date.UTC(...fields);
  if (zone.toUpperCase() === "Z") return utc;
  const z = zone.replace(":", "");
  const offset = (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5))) * 60_000;
  return z[0] === "+" ? utc - offset : utc + offset;
}

const CLOCK = /^(\d{1,2}):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?$/;

/**
 * The time the user typed in "Jump to time": a full timestamp (`2026-11-16
 * 10:30`, `2026-11-16T10:30:00Z`), or a clock time `HH:MM[:SS]` in local
 * time on the day of `latest` (the newest line), or the day before when
 * that would be later than it. NaN when it cannot be read.
 */
export function parseJumpTime(input: string, latest: number): number {
  const s = input.trim();
  if (!s) return NaN;
  const full = lineTime(s);
  if (!Number.isNaN(full)) return full;
  const m = CLOCK.exec(s);
  if (!m) return NaN;
  const [h, mi, sec] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || sec > 59) return NaN;
  const ms = Number((m[4] ?? "0").padEnd(3, "0"));
  const base = new Date(Number.isNaN(latest) ? Date.now() : latest);
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi, sec, ms).getTime();
  // A minute of slack: "10:30" while the newest line is 10:29:59.
  if (!Number.isNaN(latest) && at > latest + 60_000) {
    const prev = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1, h, mi, sec, ms);
    return prev.getTime();
  }
  return at;
}

export type JumpResult =
  /** `first`: no earlier line has a time (the buffer may not reach back that far). */
  | { kind: "line"; index: number; first: boolean }
  /** Every line is earlier: the newest one. */
  | { kind: "after-last"; index: number }
  | { kind: "no-times" };

/**
 * The first of `lines` at or after `target`. Lines without a time are
 * skipped; merged streams may be slightly out of order, so it scans rather
 * than bisects (50,000 lines take a few ms).
 */
export function findTime(count: number, textAt: (i: number) => string | undefined, target: number): JumpResult {
  let last = -1;
  for (let i = 0; i < count; i++) {
    const text = textAt(i);
    if (text === undefined) continue;
    const t = lineTime(text);
    if (Number.isNaN(t)) continue;
    if (t >= target) return { kind: "line", index: i, first: last < 0 };
    last = i;
  }
  return last < 0 ? { kind: "no-times" } : { kind: "after-last", index: last };
}
