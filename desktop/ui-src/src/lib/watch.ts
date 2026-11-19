/**
 * The watch log: a calm, per-cluster record of keeping watch over it. How
 * long the deck has been calm (no problem pods), which hours of the day were
 * calm or rough, how many problems cleared, and a few brass insignia.
 * Nothing here nags: it only notes what already happened.
 */

export type HourMark = "calm" | "rough";

export interface WatchLog {
  /** Since when no problem pod was seen, or null while there are some. */
  calmSince: number | null;
  /** The longest calm stretch seen, in ms. */
  bestCalm: number;
  /** Problems that left the list, ever and today. */
  cleared: number;
  clearedToday: number;
  day: string;
  /** Hour start (ms, as a string) → how it went; the last 24 kept. */
  hours: Record<string, HourMark>;
  /** Badge id → when it was earned. */
  badges: Record<string, number>;
  /** The problems cleared lately, newest last: the knots on the wake line. */
  knots: Knot[];
  /** The problem pods of the last update ("ns/name"). */
  last: string[];
  /** The last list was cut short, so who left it is unknown. */
  lastPartial: boolean;
  lastSeen: number;
}

export interface Knot {
  /** "ns/name" of the pod that cleared. */
  key: string;
  at: number;
}

/** How many knots the log keeps. */
export const KNOTS_MAX = 24;

export interface Badge {
  id: string;
  title: string;
  /** How it is earned, shown on a locked badge. */
  how: string;
  /** Progress toward it, 0–1, and a short text ("23 / 60 min"). */
  progress: (log: WatchLog, now: number) => { value: number; text: string };
}

const HOUR = 3_600_000;
const MIN = 60_000;
/** A gap longer than this between updates breaks the calm streak: nobody watched. */
export const WATCH_GAP_MS = 10 * MIN;

export function calmFor(log: WatchLog, now: number): number {
  return log.calmSince === null ? 0 : Math.max(0, now - log.calmSince);
}

function ratio(n: number, of: number, unit = ""): { value: number; text: string } {
  return { value: Math.min(1, n / of), text: `${Math.min(n, of)} / ${of}${unit}` };
}

export const BADGES: Badge[] = [
  {
    id: "first-light",
    title: "First light",
    how: "See the deck with no problem pods",
    progress: (l) => ({ value: l.calmSince !== null ? 1 : 0, text: l.calmSince !== null ? "1 / 1" : "0 / 1" }),
  },
  {
    id: "steady-hand",
    title: "Steady hand",
    how: "Clear a problem pod",
    progress: (l) => ratio(l.cleared, 1),
  },
  {
    id: "calm-hour",
    title: "Calm hour",
    how: "Keep the deck calm for an hour",
    progress: (l, now) => ratio(Math.floor(Math.max(calmFor(l, now), l.bestCalm) / MIN), 60, " min"),
  },
  {
    id: "clear-decks",
    title: "Clear decks",
    how: "Clear ten problem pods",
    progress: (l) => ratio(l.cleared, 10),
  },
  {
    id: "long-watch",
    title: "Long watch",
    how: "Keep the deck calm for four hours",
    progress: (l, now) => ratio(Math.floor(Math.max(calmFor(l, now), l.bestCalm) / HOUR), 4, " h"),
  },
];

export function dayOf(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function emptyLog(now: number): WatchLog {
  return {
    calmSince: null,
    bestCalm: 0,
    cleared: 0,
    clearedToday: 0,
    day: dayOf(now),
    hours: {},
    badges: {},
    knots: [],
    last: [],
    lastPartial: true,
    lastSeen: 0,
  };
}

/** A stored log, or a new one when it is missing or unreadable. */
export function parseLog(raw: string | null, now: number): WatchLog {
  if (!raw) return emptyLog(now);
  try {
    const l = { ...emptyLog(now), ...JSON.parse(raw) } as WatchLog;
    return typeof l.cleared === "number" && typeof l.hours === "object" && Array.isArray(l.knots)
      ? l
      : emptyLog(now);
  } catch {
    return emptyLog(now);
  }
}

export interface Observation {
  log: WatchLog;
  /** Problem pods that left the list in this update. */
  cleared: string[];
  /** Badges first earned in this update. */
  earned: Badge[];
}

/**
 * One overview update. `problems` are the problem pods shown, `total` how
 * many there are (the list may be cut short). `fresh` marks the first
 * update of a feed: its list is a new baseline, nothing "cleared".
 */
export function observe(prev: WatchLog, problems: string[], total: number, now: number, fresh: boolean): Observation {
  const log: WatchLog = { ...prev, hours: { ...prev.hours }, badges: { ...prev.badges } };
  const partial = total > problems.length;
  const gap = now - prev.lastSeen > WATCH_GAP_MS;

  let cleared: string[] = [];
  if (!fresh && !gap && !partial && !prev.lastPartial) {
    const still = new Set(problems);
    cleared = prev.last.filter((k) => !still.has(k));
  }
  const today = dayOf(now);
  if (log.day !== today) {
    log.day = today;
    log.clearedToday = 0;
  }
  log.cleared += cleared.length;
  log.clearedToday += cleared.length;
  if (cleared.length > 0) {
    log.knots = [...prev.knots, ...cleared.map((key) => ({ key, at: now }))].slice(-KNOTS_MAX);
  }

  // The calm streak: broken by a problem, or by nobody watching for a while.
  if (total > 0) {
    log.calmSince = null;
  } else if (log.calmSince === null || gap) {
    log.calmSince = now;
  }
  log.bestCalm = Math.max(log.bestCalm, calmFor(log, now));

  // The hour's mark: one rough moment makes it rough.
  const hour = String(Math.floor(now / HOUR) * HOUR);
  if (total > 0) log.hours[hour] = "rough";
  else log.hours[hour] ??= "calm";
  const keep = Object.keys(log.hours)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, 24);
  log.hours = Object.fromEntries(keep.map((h) => [String(h), log.hours[String(h)]]));

  log.last = problems;
  log.lastPartial = partial;
  log.lastSeen = now;

  const earned = BADGES.filter((b) => !log.badges[b.id] && b.progress(log, now).value >= 1);
  for (const b of earned) log.badges[b.id] = now;
  return { log, cleared, earned };
}

/** The last `n` hours, oldest first: calm, rough, or null when nobody watched. */
export function recentHours(log: WatchLog, now: number, n = 12): { start: number; mark: HourMark | null }[] {
  const current = Math.floor(now / HOUR) * HOUR;
  return Array.from({ length: n }, (_, i) => {
    const start = current - (n - 1 - i) * HOUR;
    return { start, mark: log.hours[String(start)] ?? null };
  });
}

/** The knots of the last `n` hours, each with where it sits on the line (0–1). */
export function recentKnots(log: WatchLog, now: number, n = 12): (Knot & { at01: number })[] {
  const end = (Math.floor(now / HOUR) + 1) * HOUR;
  const start = end - n * HOUR;
  return log.knots.filter((k) => k.at >= start && k.at <= end).map((k) => ({ ...k, at01: (k.at - start) / (end - start) }));
}

/** "42m", "3h 05m", "2d 4h". */
export function streakText(ms: number): string {
  const m = Math.floor(ms / MIN);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

