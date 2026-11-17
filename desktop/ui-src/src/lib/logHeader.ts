// The header of a downloaded log (#339): where the lines came from, the
// options of the stream, the time they cover and the filter in use, as
// `#` comment lines above the log lines.

import type { LogQuery } from "./logFilter";
import { lineTime } from "./logFilter";

export interface LogHeaderInfo {
  /** The kubeconfig context (the cluster's id). */
  context: string;
  namespace: string;
  /** Single-pod mode: the pod. */
  pod?: string;
  /** Workload mode: its kind and name. */
  workload?: { kind: string; name: string };
  /** The container, "" for all of them. */
  container: string;
  previous: boolean;
  /** "200", or "all". */
  tail: string;
  /** Seconds, or "all". */
  since: string;
  /** The search box and its toggles; empty text: none. */
  search: LogQuery;
  /** Highlight mode: the search did not hide lines. */
  highlight: boolean;
  /** The exclude box (same toggles as the search). */
  exclude: string;
  /** Lines of context around each match (filter mode). */
  contextLines: number;
  /** Workload mode: the pod picked in the pod filter, "" for all. */
  podFilter: string;
  /** Lines saved, and lines in the buffer. */
  saved: number;
  buffered: number;
  /** The saved lines (without pod prefixes), for the time range. */
  texts: readonly string[];
  /** When it was saved. */
  now: Date;
}

function since(s: string): string {
  if (s === "all") return "all time";
  const n = Number(s);
  if (n % 3600 === 0) return `last ${n / 3600}h`;
  if (n % 60 === 0) return `last ${n / 60}m`;
  return `last ${n}s`;
}

function iso(t: number): string {
  return new Date(t).toISOString();
}

/** The time of the first and the last of `texts` that start with one. */
export function timeRange(texts: readonly string[]): [number, number] | null {
  let first = NaN;
  let last = NaN;
  for (let i = 0; i < texts.length && Number.isNaN(first); i++) first = lineTime(texts[i]);
  for (let i = texts.length - 1; i >= 0 && Number.isNaN(last); i--) last = lineTime(texts[i]);
  return Number.isNaN(first) ? null : [first, last];
}

/** What narrowed the saved lines, or "none". */
export function filterSummary(info: LogHeaderInfo): string {
  const parts: string[] = [];
  const how = [info.search.regex ? "regex" : "text", info.search.matchCase ? "match case" : "ignore case"].join(", ");
  if (info.search.text) {
    let s = `${info.highlight ? "highlight" : "match"} ${JSON.stringify(info.search.text)} (${how})`;
    if (!info.highlight && info.contextLines > 0)
      s += `, ${info.contextLines} ${info.contextLines === 1 ? "line" : "lines"} of context`;
    parts.push(s);
  }
  if (info.exclude) parts.push(`exclude ${JSON.stringify(info.exclude)}${info.search.text ? "" : ` (${how})`}`);
  if (info.podFilter) parts.push(`pod ${info.podFilter}`);
  return parts.length ? parts.join("; ") : "none";
}

/** The header lines, each starting with "# ", and a blank "#" line after them. */
export function logHeader(info: LogHeaderInfo): string {
  const rows: [string, string][] = [
    ["Context", info.context],
    ["Namespace", info.namespace],
  ];
  if (info.workload) rows.push(["Workload", `${info.workload.kind}/${info.workload.name}`]);
  else rows.push(["Pod", info.pod ?? ""]);
  rows.push(["Container", (info.container || "all") + (info.previous ? " (previous)" : "")]);
  rows.push(["Requested", `${info.tail === "all" ? "all lines" : `last ${info.tail} lines`}, ${since(info.since)}`]);
  const range = timeRange(info.texts);
  rows.push(["Time range", range ? `${iso(range[0])} to ${iso(range[1])}` : "unknown (no timestamps on the lines)"]);
  rows.push(["Filter", filterSummary(info)]);
  rows.push(["Lines", info.saved === info.buffered ? `${info.saved}` : `${info.saved} of ${info.buffered}`]);
  rows.push(["Saved", iso(info.now.getTime())]);
  const width = Math.max(...rows.map(([k]) => k.length)) + 1;
  return ["# nauvi logs", ...rows.map(([k, v]) => `# ${(k + ":").padEnd(width)} ${v}`), "#", ""].join("\n");
}
