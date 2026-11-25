// The Workloads overview feed (`commands/workloads.rs`).

import { workloadsOverview } from "../fixtures/workloads";
import { sendWorkloads } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function workloadsHandlers(s: FakeState) {
  return {
    cmdWorkloadsStart: (id, namespaces, onEvent) => {
      s.workloadsFeeds.set(id, [...namespaces]);
      s.workloadsChannels.set(id, onEvent);
      s.lastWorkloads = id;
      // Like the backend: the first summary, then "live".
      setTimeout(() => {
        if (!s.workloadsFeeds.has(id)) return;
        sendWorkloads(s, id, { type: "update", overview: workloadsOverview(s.cluster, namespaces) });
        sendWorkloads(s, id, { type: "state", state: "live" });
      }, 0);
      return null;
    },
    cmdWorkloadsStop: (id) => {
      s.workloadsFeeds.delete(id);
      return null;
    },
  } satisfies AreaHandlers;
}
