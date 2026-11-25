// The Applications feed (`commands/applications.rs`): the list of
// `cluster.applications`, then "live", on the feed's channel (#115). Change
// the list and press Refresh (or switch namespaces), or `emitApplications`,
// to see a new one.

import { applicationsList } from "../fixtures/applications";
import { sendApplications } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function applicationsHandlers(s: FakeState) {
  return {
    cmdApplicationsStart: (id, namespaces, onEvent) => {
      s.applicationsFeeds.set(id, [...namespaces]);
      s.applicationsChannels.set(id, onEvent);
      s.lastApplications = id;
      setTimeout(() => {
        if (!s.applicationsFeeds.has(id)) return;
        sendApplications(s, id, { type: "update", list: applicationsList(s.cluster, namespaces) });
        sendApplications(s, id, { type: "state", state: "live" });
      }, 0);
      return null;
    },
    cmdApplicationsStop: (id) => {
      s.applicationsFeeds.delete(id);
      return null;
    },
  } satisfies AreaHandlers;
}
