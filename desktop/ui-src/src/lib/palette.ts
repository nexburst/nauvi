// Command palette entries and how a query picks them. Building the entries
// from the app's state lives in `stores/palette.svelte.ts`; this module is
// pure so the ranking is unit tested.

import { bestScore } from "./fuzzy";

export type PaletteGroup =
  | "Recent"
  | "Pinned"
  | "Command"
  | "Action"
  | "Kind"
  | "Namespace"
  | "Context"
  | "Window"
  | "Object";

export interface PaletteItem {
  /** Stable across openings (recent items are remembered by it). */
  id: string;
  group: Exclude<PaletteGroup, "Recent">;
  label: string;
  /** Shown dimmed after the label. */
  detail?: string;
  /** What the query is matched against; the label is always included. */
  terms?: string[];
  /** The id the access check knows the entry by (an action's, "logs",
   *  "shell"), for entries RBAC or a read-only context may refuse (#349). */
  access?: string;
  /** Not offered: why (the access check's "Not allowed: …"). */
  reason?: string;
  /** What Tab completes the query to, after its prefix (`:` + a kind's
   *  plural, `ns ` + a namespace, #591). None: Tab moves to the next result. */
  complete?: string;
  run: () => void;
}

export type Scope = "all" | "actions" | "namespaces" | "contexts" | "windows" | "kinds";

/** The prefix that lists the contexts to open in a new window. */
export const WINDOW_PREFIX = "win ";

/** The prefix that lists the kinds, as k9s's command mode (`:pods`, #575). */
export const KIND_PREFIX = ":";

const PREFIXES: Record<string, Scope> = { ns: "namespaces", ctx: "contexts", win: "windows" };

/**
 * `>` limits the palette to actions, `:` to kinds, `ns ` to namespaces,
 * `ctx ` to contexts, `win ` to opening a context in a new window.
 */
export function parseQuery(raw: string): { scope: Scope; text: string } {
  const q = raw.trimStart();
  if (q.startsWith(">")) return { scope: "actions", text: q.slice(1).trim() };
  if (q.startsWith(KIND_PREFIX)) return { scope: "kinds", text: q.slice(1).trim() };
  const m = /^(ns|ctx|win)(\s+|$)(.*)$/i.exec(q);
  // "ns" alone is also the Namespaces kind's alias: only a space makes it a prefix.
  if (m && m[2]) return { scope: PREFIXES[m[1].toLowerCase()], text: m[3].trim() };
  return { scope: "all", text: q.trim() };
}

/**
 * The query Tab turns `raw` into for `item` (#591): its completion after
 * the prefix the user typed (`:na` -> `:namespaces`, `ns kube` ->
 * `ns kube-system`), or null when it has none or the query already is it
 * (Tab then moves to the next result, as shells cycle).
 */
export function completeQuery(raw: string, item: PaletteItem): string | null {
  if (!item.complete) return null;
  const q = raw.trimStart();
  let prefix = "";
  if (q.startsWith(">")) prefix = ">";
  else if (q.startsWith(KIND_PREFIX)) prefix = KIND_PREFIX;
  else {
    const m = /^(ns|ctx|win)(\s+)/i.exec(q);
    if (m) prefix = `${m[1]} `;
  }
  const out = prefix + item.complete;
  return out === raw.trim() ? null : out;
}

const IN_SCOPE: Record<Scope, PaletteItem["group"][] | null> = {
  all: null,
  actions: ["Action", "Command"],
  namespaces: ["Namespace"],
  contexts: ["Pinned", "Context"],
  windows: ["Window"],
  kinds: ["Kind"],
};

/**
 * Objects only show up once something is typed: a table can be huge. The
 * "open in new window" entries would repeat every context.
 */
const NEEDS_QUERY: PaletteItem["group"][] = ["Object", "Window"];

export const MAX_RESULTS = 50;
const RECENT_BONUS = 40;

export interface Ranked {
  item: PaletteItem;
  /** "Recent" for remembered items when nothing is typed. */
  group: PaletteGroup;
}

/** The items to show for `raw`, best first. `recent` is newest first. */
export function rankItems(items: PaletteItem[], raw: string, recent: string[]): Ranked[] {
  const { scope, text } = parseQuery(raw);
  const groups = IN_SCOPE[scope];
  const pool = items.filter((it) => !groups || groups.includes(it.group));
  const recency = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? 0 : RECENT_BONUS - i;
  };

  if (!text) {
    const byId = new Map(pool.map((it) => [it.id, it]));
    const recents = recent.flatMap((id) => byId.get(id) ?? []);
    const seen = new Set(recents.map((it) => it.id));
    const rest = pool.filter((it) => !seen.has(it.id) && (scope !== "all" || !NEEDS_QUERY.includes(it.group)));
    return [
      ...recents.map((item) => ({ item, group: "Recent" as const })),
      ...rest.map((item) => ({ item, group: item.group })),
    ].slice(0, MAX_RESULTS);
  }

  const scored: { item: PaletteItem; score: number; order: number }[] = [];
  pool.forEach((item, order) => {
    const s = bestScore(text, [item.label, ...(item.terms ?? [])]);
    if (s !== null) scored.push({ item, score: s + recency(item.id), order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, MAX_RESULTS).map(({ item }) => ({ item, group: item.group }));
}

/** Remember `id` as the most recent pick (keeps the 10 newest). */
export function pushRecent(recent: string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, 10);
}

/** The reason of each gated item (by item id) from the refused access ids
 *  (`denied`: access id -> reason), for one object. */
export function reasonsByItem(items: PaletteItem[], denied: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const it of items) {
    const reason = it.access ? denied.get(it.access) : undefined;
    if (reason) out.set(it.id, reason);
  }
  return out;
}

/** `items` with the reasons of the refused ones set. */
export function withReasons(items: PaletteItem[], reasons: Map<string, string>): PaletteItem[] {
  if (reasons.size === 0) return items;
  return items.map((it) => (reasons.has(it.id) ? { ...it, reason: reasons.get(it.id) } : it));
}
