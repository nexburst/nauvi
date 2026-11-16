// The cluster catalog (#78): the kubeconfig sources, each context's status,
// the favourites and which cluster's settings page is open. The contexts
// themselves are `app.contexts`.

import { commands, events } from "../bindings";
import type { ContextCheck, ExecCommand, SourceInfo } from "../bindings";
import { checkedOnOpen, commandsToAsk, displayName, runLimited, toggleFavourite } from "../catalog";
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
  /** Login commands of an added source waiting for the user's OK (#201). */
  prompt = $state.raw<{ source: string; commands: ExecCommand[] } | null>(null);
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

/**
 * Log in to one cluster and record whether it answered. `asked`: the user
 * chose this context; otherwise one that sends local files from outside
 * its added kubeconfig's folder is not checked (#244).
 */
export async function checkContext(id: string, asked = false) {
  setCheck(id, "checking");
  try {
    setCheck(id, await commands.cmdCheckContext(id, asked));
  } catch (e) {
    setCheck(id, { name: id, state: "invalid", message: String(e), version: "" });
  }
}

/** Check every context, a few at a time. */
export function checkAll(): Promise<void> {
  return runLimited(
    app.contexts.map((c) => c.name),
    CHECKS_AT_ONCE,
    (id) => checkContext(id),
  );
}

/** What opening the catalog checks: every context that logs in without running a plugin. */
export function checkOnOpen(): Promise<void> {
  return runLimited(checkedOnOpen(app.contexts), CHECKS_AT_ONCE, (id) => checkContext(id));
}

/**
 * Check context `id` because the user asked. If logging in runs a command
 * of an added kubeconfig they have not allowed, ask first (#201).
 */
export async function checkOnDemand(id: string) {
  const ctx = app.contexts.find((c) => c.name === id);
  if (ctx?.source && ctx.login_command) {
    const ask = commandsToAsk(await execCommands(ctx.source), [id]);
    if (ask.length) {
      catalog.prompt = { source: ctx.source, commands: ask };
      return;
    }
  }
  await checkContext(id, true);
}

async function execCommands(source: string): Promise<ExecCommand[]> {
  try {
    return await commands.cmdExecCommands(source);
  } catch (e) {
    catalog.error = String(e);
    return [];
  }
}

/** Answer the open prompt: remember it, then check the contexts it was about. */
export async function answerPrompt(allow: boolean) {
  const prompt = catalog.prompt;
  if (!prompt) return;
  catalog.prompt = null;
  try {
    for (const c of prompt.commands) await commands.cmdAnswerExecCommand(prompt.source, c.command, allow);
  } catch (e) {
    catalog.error = String(e);
    return;
  }
  // Refused: the check says so without running anything.
  const ids = prompt.commands.flatMap((c) => c.contexts);
  await runLimited(ids, CHECKS_AT_ONCE, (id) => checkContext(id, true));
}

/** After a source changed: the contexts, the sources, and the new contexts' status. */
async function reload() {
  const known = new Set(app.contexts.map((c) => c.name));
  await Promise.all([loadContexts(), loadSources()]);
  const added = app.contexts.filter((c) => !known.has(c.name));
  void runLimited(checkedOnOpen(added), CHECKS_AT_ONCE, (id) => checkContext(id));
}

/** After adding a source: ask about the login commands it brought (#201). */
async function askAboutNewSources(before: readonly string[]) {
  for (const s of catalog.sources) {
    if (before.includes(s.path)) continue;
    const ask = commandsToAsk(await execCommands(s.path));
    if (ask.length) {
      catalog.prompt = { source: s.path, commands: ask };
      return;
    }
  }
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

/** Run a change that adds a source, then ask about its login commands. */
async function add(run: () => Promise<SourceInfo[]>): Promise<boolean> {
  const before = catalog.sources.map((s) => s.path);
  const ok = await change(run);
  if (ok) await askAboutNewSources(before);
  return ok;
}

export const addSource = (path: string) => add(() => commands.cmdAddKubeconfigSource(path));
export const pasteKubeconfig = (yaml: string, name: string) => add(() => commands.cmdPasteKubeconfig(yaml, name));
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
