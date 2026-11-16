// Back/forward history of one window (#223): where the user was, as the
// view, the namespace selection and the object in the detail panel. The
// table filter, sorting and scrolling are not part of a place, so typing in
// the filter never adds an entry. `navigation.svelte.ts` records the places
// and moves between them; this store only keeps the list.

import type { Target } from "./detail.svelte";

export interface Place {
  view: string;
  /** As `app.selectedNamespaces` (empty: all namespaces). */
  namespaces: readonly string[];
  target: Target | null;
}

/** The oldest entries are dropped beyond this. */
export const HISTORY_LIMIT = 100;

/**
 * Namespace changes this close together are one entry: ticking three
 * namespaces in the picker is one step back, not three.
 */
export const MERGE_MS = 1500;

export function samePlace(a: Place, b: Place): boolean {
  return (
    a.view === b.view &&
    a.namespaces.length === b.namespaces.length &&
    a.namespaces.every((n, i) => n === b.namespaces[i]) &&
    sameTarget(a.target, b.target)
  );
}

function sameTarget(a: Target | null, b: Target | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.resource.group === b.resource.group &&
    a.resource.kind === b.resource.kind &&
    a.namespace === b.namespace &&
    a.name === b.name
  );
}

/** Only the namespaces differ: a candidate for merging (see `MERGE_MS`). */
function onlyNamespaces(a: Place, b: Place): boolean {
  return a.view === b.view && sameTarget(a.target, b.target) && !samePlace(a, b);
}

function copy(p: Place): Place {
  const t = p.target;
  return {
    view: p.view,
    namespaces: [...p.namespaces],
    target: t && { resource: { ...t.resource }, namespace: t.namespace, name: t.name },
  };
}

export class History {
  /** Replaced, never mutated. */
  entries = $state.raw<Place[]>([]);
  index = $state(-1);
  canBack = $derived(this.index > 0);
  canForward = $derived(this.index >= 0 && this.index < this.entries.length - 1);

  /**
   * Until `settle`, every place replaces the only entry: the app is still
   * restoring the remembered namespaces and view (at start, after a context
   * switch), which the user did not navigate to.
   */
  #settling = true;
  /** When the current entry was last changed by a namespace-only step. */
  #mergeUntil = 0;

  current(): Place | null {
    return this.entries[this.index] ?? null;
  }

  /** The window is now at `place`. */
  record(place: Place, now = Date.now()) {
    const cur = this.current();
    if (cur && samePlace(cur, place)) return;
    if (this.#settling || !cur) {
      this.entries = [copy(place)];
      this.index = 0;
      return;
    }
    const merge = onlyNamespaces(cur, place) && now < this.#mergeUntil;
    const kept = this.entries.slice(0, merge ? this.index : this.index + 1);
    const next = [...kept, copy(place)];
    this.entries = next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
    this.index = this.entries.length - 1;
    this.#mergeUntil = onlyNamespaces(cur, place) ? now + MERGE_MS : 0;
  }

  /** Restoring is over: `place` is where the history starts. */
  settle(place: Place) {
    if (!this.#settling) return;
    this.record(place);
    this.#settling = false;
  }

  /** Forget everything (a context switch); restoring starts again. */
  reset() {
    this.entries = [];
    this.index = -1;
    this.#settling = true;
    this.#mergeUntil = 0;
  }

  /**
   * Move `delta` entries (-1 back, 1 forward) and return the place to show,
   * or null at either end. The caller shows it; recording that place again
   * is then a no-op.
   */
  step(delta: number): Place | null {
    const to = this.index + delta;
    if (this.#settling || to < 0 || to >= this.entries.length) return null;
    this.index = to;
    this.#mergeUntil = 0;
    return copy(this.entries[to]);
  }
}

/** This window's history. */
export const history = new History();
