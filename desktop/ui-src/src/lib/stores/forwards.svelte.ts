import { openUrl } from "@tauri-apps/plugin-opener";
import { api, onClusterSwitch, visibleCluster } from "../cluster";
import type { ForwardInfo, ForwardTarget, SavedForward } from "../bindings";
import { forwardLabel, isLocalUrl, parseLocalPort, parseRemotePort, PORT_FORWARDS_VIEW } from "../forwards";
import { setNotice } from "./actions.svelte";
import { setView } from "./app.svelte";

/**
 * Port-forwards run in the backend, independent of any panel: closing a
 * panel does not stop them. This store mirrors the backend's list, polled
 * while something that shows it is mounted.
 */
class Forwards {
  /** The running forwards of this window, replaced on every refresh. */
  list = $state.raw<ForwardInfo[]>([]);
  /** The saved forwards of the context (#217), refreshed on changes. */
  saved = $state.raw<SavedForward[]>([]);
  /** Saved ids of the forwards another window runs (#292). */
  elsewhere = $state.raw<string[]>([]);
  /** Why a saved forward did not start, by saved id (cleared once it does). */
  errors = $state.raw<Record<string, string>>({});
}
export const forwards = new Forwards();

// The list is of the cluster shown; the old one's forwards run on (ADR 0007).
onClusterSwitch(() => {
  forwards.list = [];
  forwards.saved = [];
  forwards.errors = {};
});

export async function refreshForwards() {
  try {
    const [list, elsewhere] = await Promise.all([api(visibleCluster()).cmdPortforwardList(), api(visibleCluster()).cmdPortforwardElsewhere()]);
    forwards.list = list;
    forwards.elsewhere = elsewhere;
  } catch {
    // The list is local to the backend; keep the last one.
  }
}

export async function refreshSaved() {
  try {
    forwards.saved = await api(visibleCluster()).cmdPortforwardSaved();
  } catch {
    // No context (yet): nothing saved to show.
    forwards.saved = [];
  }
}

function setError(id: string, error: string) {
  const next = { ...forwards.errors };
  if (error) next[id] = error;
  else delete next[id];
  forwards.errors = next;
}

const POLL_MS = 1000;
let pollers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Keep the list fresh while the caller is mounted; returns the cleanup. */
export function pollForwards(): () => void {
  pollers += 1;
  if (!timer) timer = setInterval(() => void refreshForwards(), POLL_MS);
  void refreshForwards();
  void refreshSaved();
  return () => {
    pollers -= 1;
    if (pollers === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The banner after a forward starts (#386): where it listens, with Open
 *  (the browser) and Port Forwards (the view) buttons. */
export function noticeForwardStarted(f: ForwardInfo) {
  setNotice(true, `Forwarding ${f.url} → ${forwardLabel(f.target)}:${f.remote}`, {
    actions: [
      { label: "Open", run: () => void openForward(f) },
      { label: "Port Forwards", run: () => setView(PORT_FORWARDS_VIEW) },
    ],
  });
}

/** Start a forward (or get the one already running). Throws the backend's message. */
export async function startForward(target: ForwardTarget, remote: string, local: number | null): Promise<ForwardInfo> {
  const f = await api(visibleCluster()).cmdPortforwardStart(target, remote, local);
  await Promise.all([refreshForwards(), refreshSaved()]);
  return f;
}

/** Start (or restart) a saved forward; opens it if it says so. Errors go
 *  to its row. Returns whether it started. */
export async function startSaved(f: SavedForward): Promise<ForwardInfo | null> {
  try {
    const info = await api(visibleCluster()).cmdPortforwardStartSaved(f.id);
    setError(f.id, "");
    if (f.open_in_browser) void openForward(info);
    return info;
  } catch (e) {
    setError(f.id, String(e));
    return null;
  } finally {
    await refreshForwards();
  }
}

/** Stop a saved forward's run and forget it. */
export async function deleteSaved(f: SavedForward) {
  try {
    await api(visibleCluster()).cmdPortforwardDelete(f.id);
    setError(f.id, "");
    setNotice(true, `Deleted the port-forward to ${forwardLabel(f.target)}:${f.remote}`);
  } catch (e) {
    setNotice(false, `Could not delete the port-forward: ${e}`);
  } finally {
    await Promise.all([refreshForwards(), refreshSaved()]);
  }
}

/** A window connected to a context: start its forwards marked "Start
 *  automatically" (#217). Never opens the browser. */
export async function autoStartForwards() {
  forwards.errors = {};
  try {
    const failed = await api(visibleCluster()).cmdPortforwardAutostart();
    for (const f of failed) setError(f.saved_id, f.error);
    if (failed.length > 0) {
      setNotice(false, failed.length === 1 ? "A saved port-forward did not start: see Network → Port Forwards." : `${failed.length} saved port-forwards did not start: see Network → Port Forwards.`);
    }
  } catch {
    // No context: nothing to start.
  }
  await Promise.all([refreshForwards(), refreshSaved()]);
}

export async function stopForward(id: string) {
  try {
    await api(visibleCluster()).cmdPortforwardStop(id);
  } finally {
    await refreshForwards();
  }
}

export async function openForward(f: ForwardInfo) {
  if (!isLocalUrl(f.url)) {
    setNotice(false, `Not opening ${f.url}: only local URLs can be opened.`);
    return;
  }
  try {
    await openUrl(f.url);
  } catch (e) {
    setNotice(false, `Could not open ${f.url}: ${e}`);
  }
}

export async function copyForwardUrl(f: ForwardInfo) {
  try {
    await navigator.clipboard.writeText(f.url);
    setNotice(true, `Copied ${f.url}`);
  } catch {
    setNotice(false, `Could not copy to the clipboard. The URL is ${f.url}`);
  }
}

/** The "Port forward…" dialog, also used to edit a saved forward. */
export const forwardDialog = $state({
  target: null as ForwardTarget | null,
  /** The saved forward being edited (`""`: a new one). */
  editId: "",
  /** The edited forward runs: saving restarts it. */
  wasRunning: false,
  remote: "",
  local: "",
  https: false,
  openInBrowser: false,
  autoStart: false,
  busy: false,
  error: "",
});

export function openForwardDialog(target: ForwardTarget, remote = "") {
  forwardDialog.target = target;
  forwardDialog.editId = "";
  forwardDialog.wasRunning = false;
  forwardDialog.remote = remote;
  forwardDialog.local = "";
  forwardDialog.https = false;
  forwardDialog.openInBrowser = false;
  forwardDialog.autoStart = false;
  forwardDialog.busy = false;
  forwardDialog.error = "";
}

export function openEditForwardDialog(f: SavedForward) {
  openForwardDialog(f.target, f.remote);
  forwardDialog.editId = f.id;
  forwardDialog.wasRunning = forwards.list.some((r) => r.saved_id === f.id);
  forwardDialog.local = f.local_port;
  forwardDialog.https = f.https;
  forwardDialog.openInBrowser = f.open_in_browser;
  forwardDialog.autoStart = f.auto_start;
}

export function closeForwardDialog() {
  forwardDialog.target = null;
}

export async function confirmForwardDialog() {
  const target = forwardDialog.target;
  if (!target || forwardDialog.busy) return;
  const remote = parseRemotePort(forwardDialog.remote);
  const local = parseLocalPort(forwardDialog.local);
  if (!remote.ok || !local.ok) {
    forwardDialog.error = !remote.ok ? remote.error : !local.ok ? local.error : "";
    return;
  }
  const editing = forwardDialog.editId !== "";
  const restart = !editing || forwardDialog.wasRunning;
  forwardDialog.busy = true;
  forwardDialog.error = "";
  try {
    const saved = await api(visibleCluster()).cmdPortforwardSave({
      id: forwardDialog.editId,
      target,
      remote: remote.value,
      local_port: local.value === null ? "" : String(local.value),
      https: forwardDialog.https,
      open_in_browser: forwardDialog.openInBrowser,
      auto_start: forwardDialog.autoStart,
    });
    await refreshSaved();
    if (restart) {
      let f: ForwardInfo;
      try {
        f = await api(visibleCluster()).cmdPortforwardStartSaved(saved.id);
      } catch (e) {
        // A new forward that never started is not kept; an edit is.
        if (!editing) await api(visibleCluster()).cmdPortforwardDelete(saved.id).catch(() => {});
        await Promise.all([refreshForwards(), refreshSaved()]);
        throw e;
      }
      setError(saved.id, "");
      await refreshForwards();
      if (saved.open_in_browser) void openForward(f);
      noticeForwardStarted(f);
    } else {
      setNotice(true, `Saved the port-forward to ${forwardLabel(target)}:${saved.remote}`);
    }
    forwardDialog.target = null;
  } catch (e) {
    forwardDialog.error = String(e);
  } finally {
    forwardDialog.busy = false;
  }
}
