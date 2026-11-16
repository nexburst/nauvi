// Back/forward (#223): records every place the window shows in `history`
// and goes back to one. Alt+Left/Right (⌘[ / ⌘] on macOS) come through the
// keyboard handler, the mouse's back/forward buttons through
// `listenMouseButtons` (keyboard.svelte.ts), and the header has two arrows.

import { untrack } from "svelte";
import { app, setNamespaces, setView } from "./app.svelte";
import { closeDetail, detail, openDetail } from "./detail.svelte";
import { history } from "./history.svelte";
import type { Place } from "./history.svelte";
import { whenDiscarded } from "./unsaved.svelte";

export function currentPlace(): Place {
  return { view: app.view, namespaces: app.selectedNamespaces, target: detail.target };
}

/**
 * Record a place whenever the view, the namespaces or the detail panel's
 * object change (once per change, however many of them change together).
 * Returns the function that stops it.
 */
export function trackHistory(): () => void {
  return $effect.root(() => {
    $effect(() => {
      if (!app.ready) return;
      const place = currentPlace();
      untrack(() => history.record(place));
    });
  });
}

/** Go back (-1) or forward (1); asks first if the detail panel has unsaved edits. */
export function go(delta: number) {
  if (delta < 0 ? !history.canBack : !history.canForward) return;
  whenDiscarded(() => {
    const place = history.step(delta);
    if (place) show(place);
  });
}

export const goBack = () => go(-1);
export const goForward = () => go(1);

/**
 * Show `place` with the same functions a click uses. An object deleted
 * since shows the panel's "was deleted" state.
 */
function show(place: Place) {
  if (place.view !== app.view) setView(place.view);
  setNamespaces(place.namespaces);
  const t = place.target;
  if (!t) {
    if (detail.target) closeDetail();
    return;
  }
  // As `openObject`: keep the filter only if the object's row matches it.
  if (!t.name.toLowerCase().includes(app.search.trim().toLowerCase())) app.search = "";
  const open = detail.target;
  const same =
    open !== null &&
    open.resource.group === t.resource.group &&
    open.resource.kind === t.resource.kind &&
    open.namespace === t.namespace &&
    open.name === t.name;
  if (!same) openDetail(t);
}
