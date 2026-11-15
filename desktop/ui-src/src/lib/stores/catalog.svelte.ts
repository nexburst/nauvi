// The cluster catalog (#78): the kubeconfig sources, each context's status,
// the favourites and which cluster's settings page is open. The contexts
// themselves are `app.contexts`.

import { commands, events } from "../bindings";
import type { ContextCheck, SourceInfo } from "../bindings";
import { displayName, runLimited, toggleFavourite } from "../catalog";
import { app, loadContexts } from "./app.svelte";
import { contextSettings, settings, updateSettings } from "./settings.svelte";

/** How many clusters are checked at once. */
const CHECKS_AT_ONCE = 4;

class CatalogStore {
  sources = $state.raw<SourceInfo[]>([]);
  /** The last check of each context id; `"checking"` while one runs. */
  checks = $state.raw(new Map<string, ContextCheck | "checking">());
  /** What went wrong adding or removing a source ("" if nothing). */
  error = $state("");
  /** The context id whose settings page is open, or null. */
  settingsFor = $state<string | null>(null);
}
export const catalog = new CatalogStore();

export async function loadSources() {
  try {
    catalog.sources = await commands.cmdKubeconfigSources();
  } catch (e) {
    catalog.error = String(e);
  }
}

function setCheck(id: string, check: ContextCheck | "checking") {
  const next = new Map(catalog.checks);
  next.set(id, check);
  catalog.checks = next;
}

/** Log in to one cluster and record whether it answered. */
export async function checkContext(id: string) {
  setCheck(id, "checking");
  try {
    setCheck(id, await commands.cmdCheckContext(id));
  } catch (e) {
    setCheck(id, { name: id, state: "invalid", message: String(e), version: "" });
  }
}

/** Check every context, a few at a time. */
export function checkAll(): Promise<void> {
  return runLimited(
    app.contexts.map((c) => c.name),
    CHECKS_AT_ONCE,
    checkContext,
  );
}

/** After a source changed: the contexts, the sources, and the new contexts' status. */
async function reload() {
  const known = new Set(app.contexts.map((c) => c.name));
  await Promise.all([loadContexts(), loadSources()]);
  const added = app.contexts.map((c) => c.name).filter((id) => !known.has(id));
  void runLimited(added, CHECKS_AT_ONCE, checkContext);
}

/** Run a source change; its error is shown in the catalog. Resolves to whether it worked. */
async function change(run: () => Promise<SourceInfo[]>): Promise<boolean> {
  catalog.error = "";
  try {
    catalog.sources = await run();
  } catch (e) {
    catalog.error = String(e);
    return false;
  }
  await reload();
  return true;
}

export const addSource = (path: string) => change(() => commands.cmdAddKubeconfigSource(path));
export const pasteKubeconfig = (yaml: string, name: string) => change(() => commands.cmdPasteKubeconfig(yaml, name));
export const removeSource = (path: string) => change(() => commands.cmdRemoveKubeconfigSource(path));

/**
 * Follow changes to the kubeconfig files (the backend polls them): reload
 * the contexts, and the sources if the catalog shows them.
 */
export function listenKubeconfigs() {
  return events.kubeconfigsChanged.listen(() => void reload());
}

export function isPinned(id: string): boolean {
  return settings.current.favourites.includes(id);
}

export function togglePin(id: string) {
  // Pins of contexts that are gone for now (a source that failed to read)
  // are kept: they come back with their source.
  updateSettings({ favourites: toggleFavourite(settings.current.favourites, id) });
}

/** The name shown for context `id`. */
export function contextLabel(id: string): string {
  return displayName({ name: id }, contextSettings(id));
}

export function openClusterSettings(id: string) {
  catalog.settingsFor = id;
}

export function closeClusterSettings() {
  catalog.settingsFor = null;
}
