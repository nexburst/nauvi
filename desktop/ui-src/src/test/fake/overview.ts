// The Overview feed (`commands/overview.rs`).

import { events } from "../../lib/bindings";
import { copy } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function overviewHandlers(s: FakeState) {
  return {
    cmdOverviewStart: (id) => {
      s.overviewFeeds.add(id);
      s.lastOverview = id;
      // Like the backend: the first summary, then "live".
      setTimeout(() => {
        if (!s.overviewFeeds.has(id)) return;
        void events.overviewUpdate.emit({ id, overview: copy(s.cluster.overview) });
        void events.overviewState.emit({ id, state: "live" });
      }, 0);
      return null;
    },
    cmdOverviewStop: (id) => {
      s.overviewFeeds.delete(id);
      return null;
    },
  } satisfies AreaHandlers;
}
