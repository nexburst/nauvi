// kubeloupe:// links (#299). "Copy link" asks the backend for an object's
// link. An opened link reaches a window as a request it takes with
// `cmdTakeLink` (on start, and whenever `linkPending` says there is one):
// it opens the object's detail panel, which only reads. Nothing a link
// says is run or changed.

import { untrack } from "svelte";
import { commands, events } from "../bindings";
import type { LinkRequest, ObjectLink, ResourceRef } from "../bindings";
import { linkKind, linkProblem } from "../links";
import { thisWindow } from "../window";
import { setNotice } from "./actions.svelte";
import { app, currentContextName, kinds, openObject, setNamespaces } from "./app.svelte";

class Links {
  /** An opened link waiting for the window to have started and discovered its kinds. */
  pending = $state.raw<ObjectLink | null>(null);
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
  commands
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
      url = await commands.cmdObjectLink(resource, namespace, name);
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
  return request.link.context;
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
  links.pending = null;
  const kind = linkKind(kinds.all, link);
  const problem = linkProblem(link, currentContextName(), kind);
  if (problem || !kind) {
    setNotice(false, problem);
    return;
  }
  // Show the object's namespace if the scope leaves it out.
  const scope = app.selectedNamespaces;
  if (link.namespace && scope.length > 0 && !scope.includes(link.namespace)) setNamespaces([link.namespace]);
  openObject(kind, link.namespace, link.name);
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
  });
  return () => {
    unlisten();
    stop();
  };
}
