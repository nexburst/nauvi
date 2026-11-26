import { api, clusterSwitched, onClusterSwitch, setVisibleCluster, visibleCluster } from "../cluster";
import { commands } from "../bindings";
import type { ContextInfo, NamespaceInfo, ResourceKind } from "../bindings";
import { joinNames, normalizeNamespaces, sameNamespaces } from "../namespaces";
import { clampHeight } from "../dock";
import { isWatchless } from "../health";
import { WORKLOADS_VIEW } from "../workloads";
import { APPLICATIONS_VIEW } from "../applications";
import { contextToRestore, namespacesToRestore } from "../settings";
import { isMainWindow } from "../window";
import { closeDetail, detail, openDetail } from "./detail.svelte";
import { checkLeftovers } from "./debug.svelte";
import { contextSettings, loadSettings, settings, updateContext, updateSettings } from "./settings.svelte";
import { closeDockTabsOf, dock } from "./dock.svelte";
import { autoStartForwards } from "./forwards.svelte";
import { clearProblems } from "./problems.svelte";
import { whenDiscarded } from "./unsaved.svelte";
import { history } from "./history.svelte";
import { filterKeeps } from "./tableFilter.svelte";
import { startupLinkContext } from "./links.svelte";
import { notify } from "./notifications.svelte";
import { becameLive } from "../statusTime";

/** `"overview"`, or the id of a discovered kind (`apps/v1/deployments`). */
export type View = string;

export interface Status {
  /** `null` while connecting, otherwise whether the cluster is reachable. */
  ok: boolean | null;
  text: string;
}

/** Shell state shared by the header, sidebar, banner and views. */
export const app = $state({
  view: "overview" as View,
  /**
   * The namespaces the views show, in the order picked (at most
   * `MAX_NAMESPACES`); empty means all namespaces. Replaced, never mutated.
   */
  selectedNamespaces: [] as string[],
  search: "",
  /**
   * Show only rows of this `ResourceRow.status` ("" = all): set by a click
   * on a count in the Workloads overview, cleared when the view changes.
   */
  statusFilter: "",
  contexts: [] as ContextInfo[],
  namespaces: [] as NamespaceInfo[],
  /** Listing namespaces is forbidden: the namespace control takes free text. */
  namespacesForbidden: false,
  /** Namespaces offered when they cannot be listed (context default + typed). */
  knownNamespaces: [] as string[],
  status: { ok: null, text: "Connecting…" } as Status,
  error: "",
  /** Footer: item count and last update, set by the active view. */
  count: "",
  /** When the view last updated, epoch ms (0: not yet); the footer shows
   *  it in the display zone (#330), so a zone change shows at once. */
  updatedAt: 0,
  /** Bumped by the Refresh button; views re-request their data on change. */
  refreshNonce: 0,
  /** The remembered context and namespaces are restored (`startApp`). */
  ready: false,
});

/** The view to open once discovery shows whether its kind still exists. */
let pendingView: View | null = null;

/** Discovery result (sidebar) and the kinds the user may not list. */
class Kinds {
  /** Replaced, never mutated: no need for deep reactivity on column defs. */
  all = $state.raw<ResourceKind[]>([]);
  /** Ids of kinds a SelfSubjectAccessReview denied in `deniedScope`. */
  denied = $state.raw(new Set<string>());
  /** The namespaces `denied` was checked in (empty = all namespaces). */
  deniedScope = $state.raw<string[]>([]);
  /** Discovery finished (successfully or not). */
  loaded = $state(false);
}
export const kinds = new Kinds();

// What one cluster sent never shows for the next (ADR 0007).
onClusterSwitch(() => {
  kinds.all = [];
  kinds.denied = new Set();
  kinds.deniedScope = [];
  kinds.loaded = false;
  app.namespaces = [];
  app.namespacesForbidden = false;
  app.knownNamespaces = [];
  app.count = "";
  app.updatedAt = 0;
  app.error = "";
  pendingView = null;
});

/** The kind of the current view, if it is one. */
export function currentKind(): ResourceKind | undefined {
  return kinds.all.find((k) => k.id === app.view);
}

export function kindOf(apiVersion: string, kind: string): ResourceKind | undefined {
  const [group, version] = apiVersion.includes("/") ? apiVersion.split("/") : ["", apiVersion];
  return (
    kinds.all.find(
      (k) => k.resource.group === group && k.resource.kind === kind && k.resource.version === version,
    ) ?? kinds.all.find((k) => k.resource.group === group && k.resource.kind === kind)
  );
}

/** Ask the cluster what it serves; the sidebar is built from the answer. */
export async function loadKinds() {
  const cluster = visibleCluster();
  let found: ResourceKind[];
  try {
    found = await api(cluster).cmdDiscover();
  } catch (e) {
    // The window shows another cluster now: its own discovery runs.
    if (cluster !== visibleCluster()) return;
    kinds.all = [];
    kinds.loaded = true;
    showError("Could not discover the cluster's resource types: " + e);
    settleHistory();
    return;
  }
  if (cluster !== visibleCluster()) return;
  kinds.all = found;
  kinds.denied = new Set();
  kinds.loaded = true;
  await checkAccess();
  restorePendingView();
  settleHistory();
}

/** Back/forward (#223) starts at what was restored, not at the overview. */
function settleHistory() {
  history.settle({ view: app.view, namespaces: app.selectedNamespaces, target: detail.target });
}

/** Open the remembered view if its kind is still served and allowed. */
function restorePendingView() {
  const view = pendingView;
  pendingView = null;
  if (!view || view === "overview" || app.view !== "overview") return;
  if (isWatchless(view)) {
    app.view = view;
    // These views watch nothing: the header would keep what the overview
    // had said before it was replaced, maybe "Connecting…" (#459), until
    // their health check (#469) answers. Discovery just got an answer, so
    // the cluster is reachable and the overview's error banner goes too.
    setStatus(true, "Live");
    showError("");
    return;
  }
  if (view === WORKLOADS_VIEW || view === APPLICATIONS_VIEW) {
    app.view = view;
    return;
  }
  const kind = kinds.all.find((k) => k.id === view);
  if (kind && (!kinds.denied.has(kind.id) || canOpenDenied(kind))) app.view = view;
}

/**
 * RBAC: grey out what the user cannot list in the current namespace scope:
 * with several namespaces, what is denied in all of them. Best effort;
 * re-run whenever the selection changes.
 */
export async function checkAccess() {
  const found = kinds.all;
  const scope = [...app.selectedNamespaces];
  if (found.length === 0) return;
  try {
    const resources = found.map((k) => k.resource);
    const answers = await Promise.all(
      (scope.length ? scope : [null]).map((ns) => api(visibleCluster()).cmdCheckAccess(resources, ns)),
    );
    // Ignore the answer if discovery or the namespaces changed meanwhile.
    if (kinds.all === found && sameNamespaces(app.selectedNamespaces, scope)) {
      const deniedIn = answers.map((access) => new Set(access.filter((a) => !a.allowed).map((a) => a.id)));
      kinds.denied = new Set(found.map((k) => k.id).filter((id) => deniedIn.every((d) => d.has(id))));
      kinds.deniedScope = scope;
    }
  } catch {
    // Without the check everything stays enabled.
  }
}

/** Why `kind` is greyed out, for its tooltip. */
export function deniedReason(kind: ResourceKind): string {
  if (!kind.resource.namespaced) return `You are not allowed to list ${kind.label}`;
  const scope = kinds.deniedScope;
  if (scope.length === 1) return `${kind.label}: not allowed in namespace ${scope[0]}`;
  if (scope.length > 1) return `${kind.label}: not allowed in namespaces ${joinNames(scope)}`;
  return `${kind.label}: not allowed across all namespaces — pick a namespace`;
}

/**
 * Whether the sidebar should still open a denied kind: a namespaced kind
 * denied across all namespaces may be allowed in one, and its view has the
 * namespace control.
 */
export function canOpenDenied(kind: ResourceKind): boolean {
  return kind.resource.namespaced && kinds.deniedScope.length === 0;
}

/** Open an object in its own kind's view (owner links, related objects). */
export function openObject(kind: ResourceKind, namespace: string, name: string) {
  whenDiscarded(() => {
    // The filter is shared by every table: keep it only if the opened
    // object's row still matches it, so the row is there (and selected).
    if (!filterKeeps(name)) app.search = "";
    setView(kind.id);
    openDetail({ resource: kind.resource, namespace, name });
  });
}

export function setStatus(ok: boolean | null, text: string) {
  const next = { ok, text };
  // A watch that comes back without a re-list sends no batch: its rows are
  // current again from now (#387).
  if (app.updatedAt && becameLive(app.status, next)) stamp();
  app.status = next;
}

export function showError(message: string) {
  // The history (#326) gets each new error once, not every repeat of it.
  if (message && message !== app.error) notify("error", message, currentContextName());
  app.error = message;
}

export function stamp() {
  app.updatedAt = Date.now();
}

export async function loadContexts() {
  try {
    app.contexts = await api(visibleCluster()).cmdListContexts();
  } catch {
    // No kubeconfig contexts (e.g. in-cluster): the selector stays hidden.
    app.contexts = [];
  }
  setVisibleCluster(currentContextName());
}

export function currentContextName(): string {
  return app.contexts.find((c) => c.current)?.name ?? "";
}

/** Offer `ns` in the namespace control when namespaces cannot be listed. */
export function rememberNamespace(ns: string) {
  if (!ns || app.knownNamespaces.includes(ns)) return;
  app.knownNamespaces = [...app.knownNamespaces, ns].sort();
  const ctx = currentContextName();
  const typed = contextSettings(ctx).typed_namespaces;
  if (!typed.includes(ns)) updateContext(ctx, { typed_namespaces: [...typed, ns] });
}

export async function loadNamespaces() {
  const cluster = visibleCluster();
  let listed: NamespaceInfo[] | null;
  try {
    listed = await api(cluster).cmdListNamespaces();
  } catch {
    // Namespaces failing usually means the cluster is unreachable;
    // the main view load will surface the error.
    return;
  }
  if (cluster !== visibleCluster()) return;
  app.namespaces = listed ?? [];
  app.namespacesForbidden = listed === null;
  const ctx = app.contexts.find((c) => c.current);
  app.knownNamespaces = [];
  if (listed === null) {
    for (const ns of [ctx?.namespace ?? "", ...contextSettings(ctx?.name ?? "").typed_namespaces]) {
      if (ns && !app.knownNamespaces.includes(ns)) app.knownNamespaces.push(ns);
    }
    app.knownNamespaces.sort();
  }
}

/**
 * List the namespaces again, so ones created or deleted since the start
 * show up in the namespace control and the palette (#177). Runs on Refresh
 * and when either opens. Quiet: a failure keeps the last list, and an
 * answer for a context that is no longer current is dropped. Resolves to
 * whether the list changed.
 */
export async function reloadNamespaces(): Promise<boolean> {
  const ctx = currentContextName();
  let listed: NamespaceInfo[] | null;
  try {
    listed = await api(visibleCluster()).cmdListNamespaces();
  } catch {
    return false;
  }
  // Not listable: the control keeps offering the known and typed ones.
  if (listed === null || app.namespacesForbidden || currentContextName() !== ctx) return false;
  const names = (list: NamespaceInfo[]) => list.map((n) => `${n.name}\n${n.status}`);
  if (sameNamespaces(names(listed), names(app.namespaces))) return false;
  app.namespaces = listed;
  return true;
}

/**
 * Pick the starting namespace: all namespaces if the user may list pods
 * cluster-wide, otherwise the context's namespace or the first one they can
 * access.
 */
export async function initScope() {
  let ns: string | null = null;
  try {
    ns = await api(visibleCluster()).cmdDefaultNamespace();
  } catch {
    // Unreachable cluster: stay on all namespaces; the views report it.
  }
  app.selectedNamespaces = ns ? [ns] : [];
  if (ns && app.namespacesForbidden && !app.knownNamespaces.includes(ns)) {
    app.knownNamespaces = [...app.knownNamespaces, ns].sort();
  }
}

/**
 * Restore what was remembered for the current context: its namespaces (or
 * the default scope) now, its view once discovery has run.
 */
async function restoreScope() {
  const saved = contextSettings(currentContextName());
  const listed = app.namespaces.map((n) => n.name);
  const namespaces = namespacesToRestore(saved.namespaces, listed, app.namespacesForbidden);
  const preferred = saved.default_namespace;
  if (namespaces) app.selectedNamespaces = namespaces;
  else if (preferred) {
    // The cluster settings' default namespace (#78).
    app.selectedNamespaces = [preferred];
    if (app.namespacesForbidden && !app.knownNamespaces.includes(preferred)) {
      app.knownNamespaces = [...app.knownNamespaces, preferred].sort();
    }
  } else await initScope();
  pendingView = saved.view || null;
  markUsed();
  void autoStartForwards();
}

/** The catalog's "last used" (#78): this window is connected to the context now. */
function markUsed() {
  const ctx = currentContextName();
  if (ctx) void updateContext(ctx, { last_used: Date.now() });
}

/**
 * Start up: load the settings, switch to the remembered context if it still
 * exists, and restore its namespaces and view.
 */
export async function startApp() {
  await loadSettings();
  // Leave room for the header and the tables, as a drag does.
  const docked = settings.current.dock_height;
  if (docked > 0) dock.height = clampHeight(docked, window.innerHeight - 160);
  await loadContexts();
  // A window opened for a context is already connected to it. The main
  // window started from a nauvi:// link (#299) starts on its context.
  const linked = isMainWindow() ? await startupLinkContext() : null;
  const remembered = isMainWindow() ? (linked ?? contextToRestore(settings.current.last_context, app.contexts)) : null;
  if (remembered) {
    try {
      await api(visibleCluster()).cmdSetContext(remembered);
      // The window shows another cluster now (ADR 0007): ask that one.
      setVisibleCluster(remembered);
      await loadContexts();
    } catch {
      // Stay on the kubeconfig's current-context.
    }
  }
  await loadNamespaces();
  await restoreScope();
  app.ready = true;
}

/** Asks first if the detail panel has unsaved edits. */
export function setView(view: View) {
  whenDiscarded(() => {
    closeDetail();
    app.view = view;
    app.statusFilter = "";
    pendingView = null;
    updateContext(currentContextName(), { view });
    app.count = "";
    app.updatedAt = 0;
    showError("");
  });
}

/** Open `kind`'s table showing only its rows of `status` (Workloads overview). */
export function openWithStatus(kind: ResourceKind, status: string) {
  whenDiscarded(() => {
    setView(kind.id);
    app.statusFilter = status;
  });
}

export function refresh() {
  app.refreshNonce += 1;
  void reloadNamespaces();
}

export async function switchContext(name: string) {
  // Showing the cluster shown already changes nothing: its streams,
  // terminals and forwards run on (a fresh session is `reconnectCluster`).
  if (name && name === currentContextName()) return;
  try {
    await api(visibleCluster()).cmdSetContext(name || null);
  } catch (e) {
    showError("Could not switch context: " + e);
    return;
  }
  // The window shows another cluster now, in a session of its own (ADR
  // 0007); `""` (the current-context) names the one shown until the
  // contexts are loaded again below. The old cluster stays connected: its
  // log streams, terminals and forwards run on (the dock tabs name their
  // cluster), its watches have stopped.
  setVisibleCluster(name);
  // The other windows' contexts are remembered by the backend.
  if (isMainWindow()) updateSettings({ last_context: name });
  await showFresh();
}

/** Show the visible cluster from nothing: nothing the window showed before stays. */
async function showFresh() {
  clusterSwitched();
  clearProblems();
  // Places in the old context mean nothing in the new one.
  history.reset();
  closeDetail();
  app.selectedNamespaces = [];
  app.view = "overview";
  app.statusFilter = "";
  await loadContexts();
  await loadNamespaces();
  await restoreScope();
  refresh();
  void checkLeftovers();
}

/**
 * Start cluster `id` over, as asked (Reconnect now after a proxy change): a
 * fresh session and client. Its log streams, terminals and forwards end, so
 * its dock tabs close, with a notice; the cluster shown starts over as on a
 * switch.
 */
export async function reconnectCluster(id: string) {
  try {
    await api(id).cmdClusterReconnect();
  } catch (e) {
    showError(`Could not reconnect ${id}: ${e}`);
    return;
  }
  const closed = dock.tabs.filter((t) => t.cluster === id).length;
  closeDockTabsOf(id);
  notify(
    "info",
    closed
      ? `Reconnected to ${id}. Its ${closed === 1 ? "dock tab was" : `${closed} dock tabs were`} closed: their logs and terminals ended.`
      : `Reconnected to ${id}.`,
    id,
  );
  if (id === currentContextName()) await showFresh();
}

/**
 * Open a new window connected to `name` (`""`: the kubeconfig's
 * current-context). This window stays as it is.
 */
export async function openContextWindow(name: string) {
  try {
    await commands.cmdOpenWindow(name);
  } catch (e) {
    // The backend says what failed.
    showError(String(e));
  }
}

/**
 * Show `namespaces` (empty: all namespaces). Typed namespaces are offered
 * again when namespaces cannot be listed; the open detail closes when its
 * object's namespace is no longer shown.
 */
export function setNamespaces(namespaces: readonly string[]) {
  const next = normalizeNamespaces(namespaces);
  if (sameNamespaces(next, app.selectedNamespaces)) return;
  if (app.namespacesForbidden) next.forEach(rememberNamespace);
  const open = detail.target?.namespace;
  if (open && next.length > 0 && !next.includes(open)) closeDetail();
  app.selectedNamespaces = next;
  updateContext(currentContextName(), { namespaces: next });
}

/** Show just `namespace` (`""`: all namespaces). */
export function switchNamespace(namespace: string) {
  setNamespaces(namespace.trim() ? [namespace] : []);
}

/**
 * The one namespace for what takes a single one (the overview's fallback
 * scope, the create dialog's default): the first selected, `""` for all.
 */
export function primaryNamespace(): string {
  return app.selectedNamespaces[0] ?? "";
}
