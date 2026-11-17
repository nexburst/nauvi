// The state of the clusters this window is connected to but does not show
// (ADR 0007, #333), as the backend reports it (`ClusterStateChanged`): kept
// connected by something running there, or disconnected while idle.

import { events } from "../bindings";
import type { ClusterStateChanged } from "../bindings";
import { thisWindow } from "../window";

class ClusterStates {
  /** The last report per cluster id; a cluster the window disconnected is dropped. */
  byId = $state.raw(new Map<string, ClusterStateChanged>());
}
export const clusterStates = new ClusterStates();

export function clusterStateChanged(change: ClusterStateChanged) {
  const next = new Map(clusterStates.byId);
  if (change.state === "disconnected") next.delete(change.cluster);
  else next.set(change.cluster, change);
  clusterStates.byId = next;
}

/** The reports of the clusters other than `visible`, by id. */
export function backgroundClusters(visible: string): ClusterStateChanged[] {
  return [...clusterStates.byId.values()]
    .filter((c) => c.cluster !== visible)
    .sort((a, b) => a.cluster.localeCompare(b.cluster));
}

export function listenClusterStates(): Promise<() => void> {
  return events.clusterStateChanged(thisWindow()).listen((e) => clusterStateChanged(e.payload));
}
