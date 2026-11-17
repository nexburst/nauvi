// Connecting a window to more clusters than the one it shows
// (`commands/clusters.rs`, ADR 0007). The fake has one cluster, so there is
// nothing to open or close; tests read `fake.calls(...)`.

import type { AreaHandlers, FakeState } from "./state";

export function clustersHandlers(_s: FakeState) {
  return {
    cmdClusterConnect: () => null,
    cmdClusterDisconnect: () => null,
  } satisfies AreaHandlers;
}
