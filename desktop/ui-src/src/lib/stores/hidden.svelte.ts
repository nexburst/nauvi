// "Remove = hide" (ADR 0007, #333): hiding a cluster takes it out of the
// tree, the context selector and the palette, in nauvi only
// (`Settings.hidden_contexts`; the kubeconfig files are never changed).
// Also what runs on each cluster of this window, for the cluster labels of
// the status bar and the Port Forwards view, and for the hide dialog.

import { commands } from "../bindings";
import type { ClusterForward } from "../bindings";
import { runningByCluster, runningText, setHidden } from "../hidden";
import type { Running } from "../hidden";
import { setNotice } from "./actions.svelte";
import { currentContextName } from "./app.svelte";
import { contextLabel } from "./catalog.svelte";
import { disconnectNode, nodeOf } from "./clusters.svelte";
import { dock } from "./dock.svelte";
import { settings, updateSettings } from "./settings.svelte";

const NOTHING: Running = { forwards: 0, tabs: 0 };

class WindowItems {
  /** The running forwards of every cluster of this window. */
  forwards = $state.raw<ClusterForward[]>([]);
  /** What runs per cluster (forwards and dock tabs). */
  byCluster = $derived(runningByCluster(this.forwards, dock.tabs));
}
export const windowItems = new WindowItems();

/** The hide dialog: the cluster asked about (`""`: closed), what runs there. */
export const hideDialog = $state({ id: "", running: NOTHING, busy: false });

export async function refreshWindowForwards() {
  try {
    windowItems.forwards = await commands.cmdPortforwardListAll();
  } catch {
    // Local to the backend; keep the last list.
  }
}

const POLL_MS = 3000;
let pollers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Keep the window's forwards fresh while the caller is mounted; returns the cleanup. */
export function pollWindowForwards(): () => void {
  pollers += 1;
  if (!timer) timer = setInterval(() => void refreshWindowForwards(), POLL_MS);
  void refreshWindowForwards();
  return () => {
    pollers -= 1;
    if (pollers === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * Disconnect cluster `id` (the tree's and the header's ✕). Its forwards
 * stopped with it, so the lists that show them follow now, not on their
 * next poll (#498). Returns whether it was disconnected.
 */
export async function disconnectCluster(id: string): Promise<boolean> {
  const done = await disconnectNode(id);
  if (done) await refreshWindowForwards();
  return done;
}

export function runningOn(id: string): Running {
  return windowItems.byCluster.get(id) ?? NOTHING;
}

export function isHidden(id: string): boolean {
  return settings.current.hidden_contexts.includes(id);
}

/** Why cluster `id` cannot be hidden from this window ("" if it can). */
export function hideProblem(id: string): string {
  return id === currentContextName() ? "Shown in this window: switch to another cluster to hide it" : "";
}

/** Ask before hiding cluster `id`, saying what runs there. */
export async function askHide(id: string) {
  if (hideProblem(id)) return;
  await refreshWindowForwards();
  hideDialog.running = runningOn(id);
  hideDialog.busy = false;
  hideDialog.id = id;
}

export function cancelHide() {
  hideDialog.id = "";
}

/**
 * Hide the cluster asked about. One this window is connected to is
 * disconnected first: what runs there stops (the dialog said so).
 */
export async function confirmHide() {
  const id = hideDialog.id;
  if (!id || hideDialog.busy) return;
  hideDialog.busy = true;
  try {
    const running = runningText(hideDialog.running);
    if (running || nodeOf(id).state !== "idle") {
      if (!(await disconnectNode(id))) return;
    }
    updateSettings({ hidden_contexts: setHidden(settings.current.hidden_contexts, id, true) });
    setNotice(
      true,
      `Hid ${contextLabel(id)} in nauvi${running ? ` and stopped ${running}` : ""}. The catalog shows it again: Show hidden, then Unhide.`,
    );
    void refreshWindowForwards();
  } finally {
    hideDialog.busy = false;
    hideDialog.id = "";
  }
}

export function unhide(id: string) {
  updateSettings({ hidden_contexts: setHidden(settings.current.hidden_contexts, id, false) });
}
