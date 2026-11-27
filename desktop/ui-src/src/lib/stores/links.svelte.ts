// nauvi:// links (#299). "Copy link" asks the backend for an object's
// link. An opened link reaches a window as a request it takes with
// `cmdTakeLink` (on start, and whenever `linkPending` says there is one):
// it opens the object's detail panel, which only reads. Nothing a link
// says is run or changed.

import { untrack } from "svelte";
import { commands, events } from "../bindings";
import { api, visibleCluster } from "../cluster";
import type { LinkRequest, ObjectLink, ResourceRef } from "../bindings";
import { linkKind, linkProblem, linkTitle } from "../links";
import { thisWindow } from "../window";
import { setNotice } from "./actions.svelte";
import { app, currentContextName, kinds, openObject, setNamespaces, setView } from "./app.svelte";
import { detail, sameTarget } from "./detail.svelte";
import type { Target } from "./detail.svelte";
import { hasUnsaved } from "./unsaved.svelte";

class Links {
  /** An opened link waiting for the window to have started and discovered its kinds. */
  pending = $state.raw<ObjectLink | null>(null);
  /** `pending` was asked for by this window's Ask AI session (`nauvi show`, #548). */
  pendingByAi = false;
  /** The object `nauvi show` opened last, while the panel still shows it:
   *  the panel says "Opened by Ask AI". */
  aiShown = $state.raw<Target | null>(null);
}
export const links = new Links();

/** Links asked for ahead of a click, by context and object (a few at most). */
const known = new Map<string, string>();
const KNOWN_MAX = 20;

const linkKey = (resource: ResourceRef, namespace: string, name: string) =>
  [currentContextName(), resource.group, resource.version, resource.kind, namespace, name].join("\n");

/**
 * Ask for an object's link before "Copy link" is clicked (the panel or the
 * row menu opened). WebKitGTK only lets a page write the clipboard during
 * the click itself, not after waiting for the backend. A failure is left
 * for the click to report.
 */
export function prefetchLink(resource: ResourceRef, namespace: string, name: string) {
  const key = linkKey(resource, namespace, name);
  if (known.has(key)) return;
  api(visibleCluster())
    .cmdObjectLink(resource, namespace, name)
    .then((url) => {
      if (known.size >= KNOWN_MAX) known.delete(known.keys().next().value!);
      known.set(key, url);
    })
    .catch(() => {});
}

/** Copy the link to an object of this window's context. */
export async function copyLink(resource: ResourceRef, namespace: string, name: string) {
  let url = known.get(linkKey(resource, namespace, name));
  if (url === undefined) {
    try {
      url = await api(visibleCluster()).cmdObjectLink(resource, namespace, name);
    } catch (e) {
      setNotice(false, String(e));
      return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    setNotice(true, `Copied the link to ${resource.kind} ${name}`);
  } catch {
    setNotice(false, `Could not copy to the clipboard. The link is ${url}`);
  }
}

async function takeLink(): Promise<LinkRequest | null> {
  try {
    return await commands.cmdTakeLink();
  } catch {
    return null;
  }
}

/** Keep an open request for later, show a notice now; the link's context, if any. */
function accept(request: LinkRequest | null): string | null {
  if (!request) return null;
  if (request.type === "notice") {
    setNotice(false, request.message);
    return null;
  }
  links.pending = request.link;
  links.pendingByAi = request.type === "askAi";
  return request.link.context;
}

/**
 * A nauvi:// link clicked in this window's Ask AI terminal (#548): checked
 * by the backend, then opened here like any opened link (or a notice).
 */
export async function openAppLink(uri: string) {
  try {
    accept(await commands.cmdCheckLink(uri));
  } catch (e) {
    setNotice(false, String(e));
  }
}

/**
 * The main window, on start: the context of the link it was started with,
 * which it connects to instead of the remembered one (the backend checked
 * that it is one of the user's), or null.
 */
export async function startupLinkContext(): Promise<string | null> {
  return accept(await takeLink());
}

/** After the start: a link that came while the window was starting. */
export async function takePendingLink() {
  accept(await takeLink());
}

/** Open the pending link's object, or say why not. */
function show() {
  const link = links.pending;
  if (!link) return;
  const byAi = links.pendingByAi;
  links.pending = null;
  links.pendingByAi = false;
  const kind = linkKind(kinds.all, link);
  const problem = linkProblem(link, currentContextName(), kind);
  if (problem || !kind) {
    setNotice(false, problem);
    return;
  }
  // Ask AI never makes the user choose about their unsaved edits.
  if (byAi && hasUnsaved()) {
    setNotice(false, `Ask AI asked to show ${linkTitle(link)}, but there are unsaved changes. Nothing was opened.`);
    return;
  }
  const scope = app.selectedNamespaces;
  if (link.name === "") {
    // A kind's table (only `nauvi show` asks for one): its namespace, if it names one.
    if (link.namespace && !(scope.length === 1 && scope[0] === link.namespace)) setNamespaces([link.namespace]);
    setView(kind.id);
    setNotice(true, `Opened by Ask AI: ${linkTitle(link)}`);
    return;
  }
  // Show the object's namespace if the scope leaves it out.
  if (link.namespace && scope.length > 0 && !scope.includes(link.namespace)) setNamespaces([link.namespace]);
  openObject(kind, link.namespace, link.name);
  links.aiShown = byAi ? { resource: kind.resource, namespace: link.namespace, name: link.name } : null;
}

/** Whether the detail panel shows what `nauvi show` opened (#548). */
export function openedByAi(target: Target | null): boolean {
  return target !== null && links.aiShown !== null && sameTarget(target, links.aiShown);
}

/**
 * Take requests when the backend says there is one, and show the pending
 * link once the window has started and knows its kinds. Returns the
 * function that stops it.
 */
export async function listenLinks(): Promise<() => void> {
  const unlisten = await events.linkPending(thisWindow()).listen(() => void takePendingLink());
  const stop = $effect.root(() => {
    $effect(() => {
      if (app.ready && kinds.loaded && links.pending) untrack(show);
    });
    // "Opened by Ask AI" lasts while the panel shows that object.
    $effect(() => {
      const shown = detail.target;
      untrack(() => {
        if (links.aiShown && !openedByAi(shown)) links.aiShown = null;
      });
    });
  });
  return () => {
    unlisten();
    stop();
  };
}
