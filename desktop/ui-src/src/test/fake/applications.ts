// The Applications feed (`commands/applications.rs`): the list of
// `cluster.applications`, then "live". Change the list and press Refresh
// (or switch namespaces) to see a new one.

import { events } from "../../lib/bindings";
import { applicationsList } from "../fixtures/applications";
import type { AreaHandlers, FakeState } from "./state";

/** Running feeds by id, with their namespaces. */
const feeds = new Map<number, string[]>();

export function applicationsHandlers(s: FakeState) {
  return {
    cmdApplicationsStart: (id, namespaces) => {
      feeds.set(id, [...namespaces]);
      setTimeout(() => {
        if (!feeds.has(id)) return;
        void events.applicationsUpdate.emit({ id, list: applicationsList(s.cluster, namespaces) });
        void events.applicationsState.emit({ id, state: "live" });
      }, 0);
      return null;
    },
    cmdApplicationsStop: (id) => {
      feeds.delete(id);
      return null;
    },
  } satisfies AreaHandlers;
}
