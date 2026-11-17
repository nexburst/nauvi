// The command palette's entries, built from the app's state each time it
// opens: commands, actions for the selected objects (#23's registry), kinds,
// namespaces, contexts and the objects of the current table.

import { replicasFromRow, targetLabel } from "../actions";
import type { PaletteItem } from "../palette";
import { HELM_VIEW } from "../helm";
import { HELM_CHARTS_VIEW } from "../helmCharts";
import { WORKLOADS_VIEW } from "../workloads";
import { APPLICATIONS_VIEW } from "../applications";
import { pushRecent, reasonsByItem, WINDOW_PREFIX } from "../palette";
import { deleteDenied, deniedActions } from "../access";
import { PORT_FORWARDS_VIEW } from "../forwards";
import {
  app,
  canOpenDenied,
  kinds,
  openContextWindow,
  refresh,
  setView,
  switchContext,
  switchNamespace,
} from "./app.svelte";
import { requestAction } from "./actions.svelte";
import { openCreate } from "./create.svelte";
import { openDetail } from "./detail.svelte";
import { dockMenuFor } from "../dock";
import { dock, openDockTab, toggleDock } from "./dock.svelte";
import { activeTable, openHelp, openPalette, openSettings } from "./keyboard.svelte";
import { openLocalShell } from "./localShell";
import { whenDiscarded } from "./unsaved.svelte";
import { checkForUpdates } from "./updates.svelte";
import { CATALOG_VIEW, displayName, orderContexts } from "../catalog";
import { shownContexts } from "../hidden";
import { openClusterSettings } from "./catalog.svelte";
import { contextSettings, settings } from "./settings.svelte";

/** Ids of recently run entries, newest first (this session). */
let recent: string[] = [];

export function recentIds(): string[] {
  return recent;
}

export function rememberPick(id: string) {
  recent = pushRecent(recent, id);
}

export function paletteItems(): PaletteItem[] {
  const current = app.contexts.find((c) => c.current)?.name ?? "";
  const label = (id: string) => displayName({ name: id }, contextSettings(id));
  // Hidden ones are left out (ADR 0007), except the one shown.
  const listed = shownContexts(app.contexts, settings.current.hidden_contexts, [current]);
  const { pinned } = orderContexts(listed, settings.current.favourites);
  const items: PaletteItem[] = [
    // The hotbar (#78): pinned clusters first, a pick switches to them.
    ...pinned.map(
      (c): PaletteItem => ({
        id: `pin:${c.name}`,
        group: "Pinned",
        label: label(c.name),
        detail: c.current ? "current" : c.server || undefined,
        terms: [c.name, c.context],
        run: () => whenDiscarded(() => void switchContext(c.name)),
      }),
    ),
    {
      id: "cmd:catalog",
      group: "Command",
      label: "Go to Cluster catalog",
      terms: ["clusters", "kubeconfig", "contexts", "hotbar", "add"],
      run: () => setView(CATALOG_VIEW),
    },
    { id: "cmd:create", group: "Command", label: "Create resource…", terms: ["new", "apply", "yaml"], run: openCreate },
    { id: "cmd:overview", group: "Command", label: "Go to Overview", run: () => setView("overview") },
    {
      id: "cmd:workloads",
      group: "Command",
      label: "Go to Workloads overview",
      terms: ["status", "deployments", "problems"],
      run: () => setView(WORKLOADS_VIEW),
    },
    {
      id: "cmd:applications",
      group: "Command",
      label: "Go to Applications",
      terms: ["apps", "instance", "labels", "releases"],
      run: () => setView(APPLICATIONS_VIEW),
    },
    { id: "cmd:helm", group: "Command", label: "Go to Helm releases", run: () => setView(HELM_VIEW) },
    {
      id: "cmd:helm-charts",
      group: "Command",
      label: "Go to Helm charts",
      terms: ["install", "repositories", "repo"],
      run: () => setView(HELM_CHARTS_VIEW),
    },
    {
      id: "cmd:port-forwards",
      group: "Command",
      label: "Go to Port Forwards",
      terms: ["forward", "tunnel"],
      run: () => setView(PORT_FORWARDS_VIEW),
    },
    { id: "cmd:refresh", group: "Command", label: "Refresh", terms: ["reload"], run: refresh },
    { id: "cmd:help", group: "Command", label: "Keyboard shortcuts", terms: ["help", "keys"], run: openHelp },
    {
      id: "cmd:settings",
      group: "Command",
      label: "Settings…",
      terms: ["preferences", "theme", "options"],
      run: openSettings,
    },
    {
      id: "cmd:check-updates",
      group: "Command",
      label: "Check for updates",
      terms: ["update", "upgrade", "version", "release"],
      run: () => void checkForUpdates(false, true),
    },
    {
      id: "cmd:local-shell",
      group: "Command",
      label: "New local terminal",
      detail: "kubectl at this context and namespace",
      terms: ["shell", "terminal", "kubectl", "console", "local"],
      run: openLocalShell,
    },
  ];
  if (current) {
    items.push({
      id: "cmd:cluster-settings",
      group: "Command",
      label: "Cluster settings…",
      detail: label(current),
      terms: ["display name", "colour", "color", "default namespace", "prometheus", "working directory"],
      run: () => openClusterSettings(current),
    });
  }
  if (app.contexts.length > 0) {
    items.push({
      id: "cmd:new-window",
      group: "Command",
      label: "Open context in new window…",
      terms: ["window", "cluster", "context"],
      // After this palette has closed, open it again on the contexts.
      run: () => setTimeout(() => openPalette(WINDOW_PREFIX)),
    });
  }
  if (dock.tabs.length > 0) {
    items.push({
      id: "cmd:dock",
      group: "Command",
      label: dock.expanded ? "Hide the dock" : "Show the dock",
      terms: ["dock", "logs", "terminal", "panel"],
      run: toggleDock,
    });
  }

  const table = activeTable();
  if (table) {
    const kind = table.kind;
    const { targets, row } = table.actionTargets();
    if (targets.length > 1) {
      const del = kind.actions.find((a) => a.id === "delete");
      if (del) {
        items.push({
          id: "action:delete",
          group: "Action",
          label: `Delete ${targets.length} selected…`,
          detail: kind.label,
          access: "delete",
          run: () => requestAction(kind, targets, del),
        });
      }
    } else if (targets.length === 1) {
      const t = targets[0];
      for (const d of dockMenuFor(kind.resource, t.namespace, t.name)) {
        items.push({
          id: `dock:${d.label}`,
          group: "Action",
          label: d.label,
          detail: targetLabel(t),
          terms: d.label === "Shell" ? ["terminal", "exec"] : ["tail"],
          access: d.label === "Shell" ? "shell" : "logs",
          run: () => openDockTab(d.spec),
        });
      }
      const keys = kind.columns.map((c) => c.key);
      for (const a of kind.actions) {
        items.push({
          id: `action:${a.id}`,
          group: "Action",
          label: a.label,
          detail: targetLabel(targets[0]),
          access: a.id,
          run: () => requestAction(kind, targets, a, replicasFromRow(row ?? undefined, keys)),
        });
      }
    }
  }

  for (const k of kinds.all) {
    if (kinds.denied.has(k.id) && !canOpenDenied(k)) continue;
    items.push({
      id: `kind:${k.id}`,
      group: "Kind",
      label: k.label,
      detail: k.resource.group || undefined,
      terms: [k.resource.plural, k.resource.kind, ...k.short_names],
      run: () => setView(k.id),
    });
  }

  // Picking a namespace shows only that one (the toolbar control adds more).
  const namespaces = app.namespacesForbidden ? app.knownNamespaces : app.namespaces.map((n) => n.name);
  items.push({
    id: "ns:",
    group: "Namespace",
    label: "All namespaces",
    detail: app.selectedNamespaces.length === 0 ? "current" : undefined,
    run: () => switchNamespace(""),
  });
  for (const ns of namespaces) {
    items.push({
      id: `ns:${ns}`,
      group: "Namespace",
      label: ns,
      detail: app.selectedNamespaces.includes(ns) ? "current" : undefined,
      run: () => switchNamespace(ns),
    });
  }

  for (const c of listed) {
    const name = label(c.name);
    items.push({
      id: `ctx:${c.name}`,
      group: "Context",
      label: name,
      detail: c.current ? "current" : undefined,
      terms: [c.name, c.context, c.server],
      run: () => whenDiscarded(() => void switchContext(c.name)),
    });
    items.push({
      id: `win:${c.name}`,
      group: "Window",
      label: `Open ${name} in new window`,
      terms: [name, c.name],
      run: () => void openContextWindow(c.name),
    });
  }

  if (table) {
    const kind = table.kind;
    for (const r of table.rows()) {
      items.push({
        id: `obj:${kind.id}:${r.key}`,
        group: "Object",
        label: `${kind.resource.plural}/${r.name}`,
        detail: r.namespace || undefined,
        terms: [r.name],
        run: () => openDetail({ resource: kind.resource, namespace: r.namespace, name: r.name }),
      });
    }
  }
  return items;
}

/** Why each of `items`' actions is refused, by item id (#349): the same
 *  access check as the row menu and the bulk bar, for the active table's
 *  selection or focused row. Empty until it answers, or if it fails. */
export async function paletteAccess(items: PaletteItem[]): Promise<Map<string, string>> {
  const table = activeTable();
  const gated = items.filter((it) => it.access);
  if (!table || gated.length === 0) return new Map();
  const { targets } = table.actionTargets();
  const resource = table.kind.resource;
  if (targets.length > 1) {
    const reason = await deleteDenied(resource, targets);
    return reasonsByItem(gated, new Map(reason ? [["delete", reason]] : []));
  }
  if (targets.length !== 1) return new Map();
  const ids = [...new Set(gated.map((it) => it.access!))];
  return reasonsByItem(gated, await deniedActions(resource, targets[0].namespace, ids));
}
