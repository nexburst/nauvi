// The cluster tree of the sidebar (ADR 0007, #333): every kubeconfig
// context, grouped by the source it came from. Pure helpers; the state of
// each node is in `stores/clusters.svelte.ts`.

import type { Category, ContextInfo, ResourceKind } from "./bindings";

/** The contexts of one source, in catalog order. */
export interface TreeGroup {
  /** The added source's path, `""` for the default kubeconfig. */
  source: string;
  label: string;
  /** The full path(s), for the tooltip. */
  title: string;
  contexts: ContextInfo[];
}

/** A node of the tree, as far as the backend is concerned. */
export type NodeState =
  /** Nothing asked of the cluster yet. */
  | "idle"
  /** Its login command waits for the user's OK (#201): nothing has run. */
  | "consent"
  | "connecting"
  | "connected"
  | "failed";

/** The last part of a path (`/a/b/team.yaml` -> `team.yaml`). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * The contexts grouped by source: the default kubeconfig first, then the
 * added sources in the order the catalog lists them.
 */
export function groupContexts(contexts: readonly ContextInfo[]): TreeGroup[] {
  const groups = new Map<string, TreeGroup>();
  const files = new Map<string, Set<string>>();
  for (const c of contexts) {
    let g = groups.get(c.source);
    if (!g) {
      g = { source: c.source, label: c.source ? baseName(c.source) : "Kubeconfig", title: c.source, contexts: [] };
      groups.set(c.source, g);
      files.set(c.source, new Set());
    }
    g.contexts.push(c);
    if (c.file) files.get(c.source)?.add(c.file);
  }
  const out = [...groups.values()];
  for (const g of out) if (!g.source) g.title = [...(files.get("") ?? [])].join("\n");
  return out.sort((a, b) => Number(a.source !== "") - Number(b.source !== ""));
}

/** The sidebar sections, in sidebar order. */
const SECTIONS: { category: Category; title: string }[] = [
  { category: "workloads", title: "Workloads" },
  { category: "network", title: "Network" },
  { category: "config", title: "Config" },
  { category: "storage", title: "Storage" },
  { category: "cluster", title: "Cluster" },
  { category: "access", title: "Access Control" },
  { category: "devices", title: "Device Resources" },
  { category: "custom", title: "Custom Resources" },
  { category: "other", title: "Other" },
];

/** `kinds` by sidebar section, empty sections left out: the resource
 *  groups of a connected node the window does not show. */
export function sectionsOf(kinds: readonly ResourceKind[]): { title: string; kinds: ResourceKind[] }[] {
  return SECTIONS.map((s) => ({ title: s.title, kinds: kinds.filter((k) => k.category === s.category) })).filter(
    (s) => s.kinds.length > 0,
  );
}

/** What a node says about its state, for its tooltip. */
export function stateText(state: NodeState, visible: boolean): string {
  if (visible) return "Shown in this window";
  switch (state) {
    case "idle":
      return "Not connected: expand to connect";
    case "consent":
      return "Waiting for your OK to run its login command";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected in the background: its logs, terminals and forwards keep running";
    case "failed":
      return "Could not connect";
  }
}
