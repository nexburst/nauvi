// State of the Applications view (#226): the live list (fed by the view's
// `cmd_applications_start` feed), its notes and the selected application,
// which the side panel shows.

import type { Application, ApplicationsList } from "../bindings";
import { appRow } from "../applications";
import type { AppRow } from "../applications";
import { onClusterSwitch } from "../cluster";
import { KeyedStore } from "./keyed.svelte";

class ApplicationsStore {
  rows = new KeyedStore<AppRow>((r) => r.key);
  notes = $state.raw<string[]>([]);
  /** The first list arrived. */
  loaded = $state(false);
  /** Key (`namespace/name`) of the selected application. */
  selected = $state<string | null>(null);
  /** The selected application, as of the newest list. */
  current = $state.raw<Application | null>(null);
}
export const apps = new ApplicationsStore();

// The applications of one cluster never show for the next (ADR 0007).
onClusterSwitch(() => resetApplications());

/** Replace the list with a new one from the feed. */
export function applyApplications(list: ApplicationsList) {
  apps.rows.applyBatch({ snapshot: true, applied: list.applications.map(appRow), deleted: [] });
  apps.notes = list.notes;
  apps.loaded = true;
  apps.current = list.applications.find((a) => a.key === apps.selected) ?? null;
  // A selected application that is gone closes its panel.
  if (!apps.current) apps.selected = null;
}

export function selectApplication(a: Application | null) {
  apps.selected = a?.key ?? null;
  apps.current = a;
}

/** Forget the list (a new feed starts, or the view closes). */
export function resetApplications(keepSelection = false) {
  apps.rows.clear();
  apps.notes = [];
  apps.loaded = false;
  if (!keepSelection) selectApplication(null);
}
