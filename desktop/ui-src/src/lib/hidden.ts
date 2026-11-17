// "Remove = hide" (ADR 0007, #333) and the cluster labels of running
// things: pure helpers. The hidden ids are `Settings.hidden_contexts`; the
// kubeconfig files are never changed.

/**
 * The contexts the tree, the selector and the palette list: the hidden ones
 * left out, except those in `keep` (the one the window shows, and ones with
 * something running in this window, so their tabs and forwards keep a node).
 */
export function shownContexts<T extends { name: string }>(
  contexts: readonly T[],
  hidden: readonly string[],
  keep: Iterable<string> = [],
): T[] {
  if (hidden.length === 0) return [...contexts];
  const out = new Set(hidden);
  for (const id of keep) out.delete(id);
  return contexts.filter((c) => !out.has(c.name));
}

/** `hidden` with `id` hidden (at the end) or shown again. */
export function setHidden(hidden: readonly string[], id: string, hide: boolean): string[] {
  const rest = hidden.filter((h) => h !== id);
  return hide ? [...rest, id] : rest;
}

/** What runs on one cluster in this window. */
export interface Running {
  forwards: number;
  tabs: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 port-forwards and 1 dock tab", "" for nothing. */
export function runningText(r: Running): string {
  const parts = [];
  if (r.forwards) parts.push(plural(r.forwards, "port-forward", "port-forwards"));
  if (r.tabs) parts.push(plural(r.tabs, "dock tab", "dock tabs"));
  return parts.join(" and ");
}

/** The short form for the status bar: "2 forwards · 1 tab". */
export function runningShort(r: Running): string {
  const parts = [];
  if (r.forwards) parts.push(plural(r.forwards, "forward", "forwards"));
  if (r.tabs) parts.push(plural(r.tabs, "tab", "tabs"));
  return parts.join(" · ");
}

/** What runs, per cluster, from the window's forwards and dock tabs.
 *  A cluster with nothing running is left out; sorted by id. */
export function runningByCluster(
  forwards: readonly { cluster: string }[],
  tabs: readonly { cluster: string; type: string }[],
): Map<string, Running> {
  const out = new Map<string, Running>();
  const at = (id: string) => {
    let r = out.get(id);
    if (!r) out.set(id, (r = { forwards: 0, tabs: 0 }));
    return r;
  };
  for (const f of forwards) if (f.cluster) at(f.cluster).forwards++;
  // A local shell runs on this machine, not on a cluster's session.
  for (const t of tabs) if (t.cluster && t.type !== "localShell") at(t.cluster).tabs++;
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Whether a list of items needs a cluster label on each: they belong to
 *  more than one cluster, or to another one than the window shows. */
export function needsClusterLabels(clusters: readonly string[], visible: string): boolean {
  return clusters.some((c) => c !== clusters[0] || c !== visible);
}
