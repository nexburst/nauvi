// The cluster tree of the sidebar (ADR 0007, #333): which nodes are
// expanded, and each node's connection. Nothing is asked of a cluster
// before the user expands or selects its node: expanding connects it in
// the background (`cmd_cluster_connect`) and lists its kinds; selecting it
// shows it in the window (`switchContext`). A login command of an added
// kubeconfig the user has not allowed asks first, inside the node (#201).

import { commands } from "../bindings";
import type { ExecCommand, ResourceKind } from "../bindings";
import { api } from "../cluster";
import { commandsToAsk } from "../catalog";
import type { NodeState } from "../clusterTree";
import { app, currentContextName, setView, showError, switchContext } from "./app.svelte";
import { closeDockTabsOf } from "./dock.svelte";
import { live } from "./live.svelte";
import { confirmDiscard } from "./unsaved.svelte";

export interface ClusterNode {
  state: NodeState;
  /** Why it could not connect (`failed`). */
  error: string;
  /** Its kinds, once listed (`null`: not yet). */
  kinds: ResourceKind[] | null;
  /** The login commands waiting for the user's OK (`consent`). */
  prompt: { source: string; commands: ExecCommand[] } | null;
  /** Show the cluster once connected (it was selected, not just expanded). */
  thenShow: string | null;
}

const IDLE: ClusterNode = { state: "idle", error: "", kinds: null, prompt: null, thenShow: null };

class ClusterTreeStore {
  /** Ids of the expanded clusters. The visible one starts expanded. */
  expanded = $state.raw(new Set<string>());
  /** Ids of the expanded clusters the user collapsed (the visible one included). */
  collapsed = $state.raw(new Set<string>());
  /** Sources whose groups are collapsed. */
  closedGroups = $state.raw(new Set<string>());
  nodes = $state.raw(new Map<string, ClusterNode>());
}
export const tree = new ClusterTreeStore();

export function nodeOf(id: string): ClusterNode {
  return tree.nodes.get(id) ?? IDLE;
}

function setNode(id: string, change: Partial<ClusterNode>) {
  const next = new Map(tree.nodes);
  next.set(id, { ...nodeOf(id), ...change });
  tree.nodes = next;
}

/** Whether node `id` shows its contents: the visible one unless collapsed. */
export function isExpanded(id: string): boolean {
  if (id === currentContextName()) return !tree.collapsed.has(id);
  return tree.expanded.has(id);
}

function setExpanded(id: string, open: boolean) {
  const expanded = new Set(tree.expanded);
  const collapsed = new Set(tree.collapsed);
  if (open) {
    expanded.add(id);
    collapsed.delete(id);
  } else {
    expanded.delete(id);
    collapsed.add(id);
  }
  tree.expanded = expanded;
  tree.collapsed = collapsed;
}

export function toggleGroup(source: string) {
  const next = new Set(tree.closedGroups);
  if (!next.delete(source)) next.add(source);
  tree.closedGroups = next;
}

/** The chevron: collapse, or expand and connect (in the background). */
export async function toggleNode(id: string) {
  if (isExpanded(id)) {
    setExpanded(id, false);
    return;
  }
  setExpanded(id, true);
  if (id !== currentContextName()) await connectNode(id);
}

/**
 * Connect cluster `id` in the background and list its kinds. Its login
 * command of an added kubeconfig runs only once allowed: until then the
 * node asks, and nothing runs.
 */
export async function connectNode(id: string): Promise<boolean> {
  const node = nodeOf(id);
  if (node.state === "connected" && node.kinds) return true;
  if (node.state === "connecting" || node.state === "consent") return false;
  const ctx = app.contexts.find((c) => c.name === id);
  if (ctx?.source && ctx.login_command) {
    let ask: ExecCommand[];
    try {
      ask = commandsToAsk(await commands.cmdExecCommands(ctx.source), [id]);
    } catch (e) {
      setNode(id, { state: "failed", error: String(e) });
      return false;
    }
    if (ask.length) {
      setNode(id, { state: "consent", error: "", prompt: { source: ctx.source, commands: ask } });
      return false;
    }
  }
  setNode(id, { state: "connecting", error: "", prompt: null });
  try {
    await api(id).cmdClusterConnect();
    const kinds = await api(id).cmdDiscover();
    // Disconnected (or shown) meanwhile: its node says so already.
    if (nodeOf(id).state !== "connecting") return false;
    setNode(id, { state: "connected", kinds });
    return true;
  } catch (e) {
    if (nodeOf(id).state === "connecting") setNode(id, { state: "failed", error: String(e) });
    return false;
  }
}

/** The answer to the prompt inside node `id`: remembered, then (allowed) connect. */
export async function answerNode(id: string, allow: boolean) {
  const prompt = nodeOf(id).prompt;
  if (!prompt) return;
  const show = nodeOf(id).thenShow;
  try {
    for (const c of prompt.commands) await commands.cmdAnswerExecCommand(prompt.source, c.command, allow);
  } catch (e) {
    setNode(id, { state: "failed", error: String(e), prompt: null, thenShow: null });
    return;
  }
  if (!allow) {
    setNode(id, {
      state: "failed",
      error: "Not connected: you chose not to run its login command. Expand it again to be asked again.",
      prompt: null,
      thenShow: null,
    });
    setExpanded(id, false);
    return;
  }
  setNode(id, { state: "idle", prompt: null, thenShow: null });
  if (await connectNode(id)) {
    if (show !== null) await showNode(id, show || undefined);
  }
}

/**
 * Show cluster `id` in the window (and `view` there, if given). A cluster
 * whose login command waits for an OK asks inside its node first.
 */
export async function showNode(id: string, view?: string) {
  if (id === currentContextName()) {
    setExpanded(id, true);
    if (view) setView(view);
    return;
  }
  const node = nodeOf(id);
  if (node.state !== "connected") {
    setExpanded(id, true);
    if (!(await connectNode(id))) {
      // Asked inside the node: show it once allowed.
      if (nodeOf(id).state === "consent") setNode(id, { thenShow: view ?? "" });
      return;
    }
  }
  if (!(await confirmDiscard())) return;
  // The backend stops the old cluster's watches; stop ours first.
  live.stop();
  const before = currentContextName();
  await switchContext(id);
  if (currentContextName() !== id) return;
  setExpanded(id, true);
  if (before) setNode(before, { state: "connected" });
  if (view) setView(view);
}

/** Disconnect cluster `id` (not the one shown): everything it runs stops.
 *  Resolves to whether it did. */
export async function disconnectNode(id: string): Promise<boolean> {
  if (id === currentContextName()) return false;
  try {
    await api(id).cmdClusterDisconnect();
  } catch (e) {
    showError(String(e));
    return false;
  }
  closeDockTabsOf(id);
  const next = new Map(tree.nodes);
  next.delete(id);
  tree.nodes = next;
  setExpanded(id, false);
  return true;
}

/**
 * The window shows `id` now (a switch from the header, the catalog, the
 * palette or a link): the cluster it showed before stays connected.
 */
export function visibleChanged(previous: string, id: string) {
  if (previous && previous !== id && nodeOf(previous).state !== "connected") {
    setNode(previous, { state: "connected", error: "", kinds: null });
  }
  if (id) {
    setNode(id, { state: "connected", error: "", prompt: null });
    // The cluster shown always opens with its resource groups, even if
    // its node was collapsed (or disconnected) before.
    if (tree.collapsed.has(id)) setExpanded(id, true);
  }
}
