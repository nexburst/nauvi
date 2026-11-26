// The watch log of the cluster on screen (lib/watch.ts), fed by the
// Overview's updates and kept per context in this webview's localStorage.

import { observe, parseLog, type Badge, type WatchLog } from "../watch";
import type { Blip } from "../sonar";
import type { ProblemPod } from "../bindings";

const KEY = "nauvi.watch.";

function load(context: string): WatchLog {
  try {
    return parseLog(localStorage.getItem(KEY + context), Date.now());
  } catch {
    return parseLog(null, Date.now());
  }
}

function save(context: string, log: WatchLog) {
  try {
    localStorage.setItem(KEY + context, JSON.stringify(log));
  } catch {
    // Storage full or blocked: the log lives for this session only.
  }
}

export const watch = $state({
  context: "",
  log: parseLog(null, Date.now()),
  /** The badge just earned, shown once until the next one. */
  earned: null as Badge | null,
  /** Bumped per earned badge, so the glint replays. */
  earnedNonce: 0,
  /** The header pill's popover is open (#491). */
  panel: false,
  /** Its tab: the problem pods (first), or the watch log (streak, insignia). */
  tab: "problems" as "problems" | "log",
});

/** What the sonar draws, from the Overview's last update. */
export const scope = $state({
  blips: [] as Blip[],
  recovered: [] as Blip[],
  healthy: 0,
  sweep: "",
  /** The problem pods of that update, as the Overview lists them (#491). */
  problems: [] as ProblemPod[],
  /** How many there are in all (the list may be cut short). */
  total: 0,
  /** The context of that update: the list is only good for it (#504). */
  context: "",
  /** When that update came. */
  at: 0,
  /** The Overview is on screen and keeps the list up to date. */
  live: false,
});

/** The problem list as of the Overview's last update of `context`, or null if it is of another one (or none came yet). */
export function problemsOf(context: string): { problems: ProblemPod[]; total: number; live: boolean; at: number } | null {
  if (!context || scope.context !== context) return null;
  return { problems: scope.problems, total: scope.total, live: scope.live, at: scope.at };
}

/** Open the header pill's popover on `tab`, or close it if it already shows it. */
export function toggleWatchPanel(tab: "problems" | "log" = "problems") {
  if (watch.panel && watch.tab === tab) {
    watch.panel = false;
    return;
  }
  watch.tab = tab;
  watch.panel = true;
}

/** An Overview update of `context`; returns the problem pods it cleared. */
export function observeOverview(context: string, problems: string[], total: number, fresh: boolean): string[] {
  if (watch.context !== context) {
    watch.context = context;
    watch.log = load(context);
    watch.earned = null;
  }
  const o = observe(watch.log, problems, total, Date.now(), fresh);
  watch.log = o.log;
  if (o.earned.length > 0) {
    watch.earned = o.earned[o.earned.length - 1];
    watch.earnedNonce++;
  }
  save(context, o.log);
  return o.cleared;
}
