// The Workloads overview feed (`commands/workloads.rs`).

import { events } from "../../lib/bindings";
import { workloadsOverview } from "../fixtures/workloads";
import type { AreaHandlers, FakeState } from "./state";

export function workloadsHandlers(s: FakeState) {
  return {
    cmdWorkloadsStart: (id, namespaces) => {
      s.workloadsFeeds.set(id, [...namespaces]);
      s.lastWorkloads = id;
      // Like the backend: the first summary, then "live".
      setTimeout(() => {
        if (!s.workloadsFeeds.has(id)) return;
        void events.workloadsUpdate.emit({ id, overview: workloadsOverview(s.cluster, namespaces) });
        void events.workloadsState.emit({ id, state: "live" });
      }, 0);
      return null;
    },
    cmdWorkloadsStop: (id) => {
      s.workloadsFeeds.delete(id);
      return null;
    },
  } satisfies AreaHandlers;
}
