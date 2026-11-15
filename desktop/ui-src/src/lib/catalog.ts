// The cluster catalog (#78): pure helpers for the catalog view, the
// favourites and the per-cluster settings. The state is in
// `stores/catalog.svelte.ts`; the contexts come from `cmd_list_contexts`.

import type { ContextInfo, ContextState, SourceKind } from "./bindings";
import type { ContextSettings } from "./settings";

/** The catalog's view id (not a cluster kind). */
export const CATALOG_VIEW = "catalog";

/** Colours offered for marking a cluster ("" = none). */
export const CLUSTER_COLORS = ["", "#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7", "#14b8a6"];

/** What the selector, palette and catalog show for a context. */
export function displayName(ctx: Pick<ContextInfo, "name">, settings: Pick<ContextSettings, "display_name"> | undefined) {
  return settings?.display_name.trim() || ctx.name;
}

/** The pinned contexts in pin order, then the others in catalog order. */
export function orderContexts<T extends Pick<ContextInfo, "name">>(
  contexts: readonly T[],
  favourites: readonly string[],
): { pinned: T[]; others: T[] } {
  const byId = new Map(contexts.map((c) => [c.name, c]));
  const pinned = favourites.flatMap((id) => byId.get(id) ?? []);
  const isPinned = new Set(pinned.map((c) => c.name));
  return { pinned, others: contexts.filter((c) => !isPinned.has(c.name)) };
}

/** `favourites` with `id` pinned (at the end) or unpinned. */
export function toggleFavourite(favourites: readonly string[], id: string): string[] {
  return favourites.includes(id) ? favourites.filter((f) => f !== id) : [...favourites, id];
}

export const STATE_LABELS: Record<ContextState, string> = {
  connected: "Connected",
  auth_error: "Login failed",
  certificate_error: "Certificate problem",
  unreachable: "Unreachable",
  invalid: "Invalid",
};

export const SOURCE_LABELS: Record<SourceKind, string> = {
  kubeconfig: "Kubeconfig",
  file: "Added file",
  folder: "Added folder",
  pasted: "Pasted",
};

/** "never", "just now", "5m ago", "3h ago", "2d ago". */
export function lastUsedText(epochMs: number, now: number): string {
  if (!epochMs) return "never";
  const s = Math.max(0, Math.floor((now - epochMs) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Namespaces typed as a list: separated by commas or spaces, no repeats. */
export function parseNamespaceList(text: string): string[] {
  const out: string[] = [];
  for (const ns of text.split(/[\s,]+/)) {
    if (ns && !out.includes(ns)) out.push(ns);
  }
  return out;
}

/** What is wrong with a namespace name typed in the cluster settings ("" if nothing). */
export function namespaceError(ns: string): string {
  if (!ns) return "";
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns) && ns.length <= 63
    ? ""
    : `${ns} is not a valid namespace name (lowercase letters, digits and -).`;
}

/** Contexts whose id, display name, server, user or file contain `query`. */
export function filterContexts<T extends ContextInfo>(
  contexts: readonly T[],
  query: string,
  names: (ctx: T) => string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...contexts];
  return contexts.filter((c) =>
    [c.name, names(c), c.server, c.user, c.cluster, c.file].some((v) => v.toLowerCase().includes(q)),
  );
}

/** Run `fn` on every item, at most `limit` at a time. */
export async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
