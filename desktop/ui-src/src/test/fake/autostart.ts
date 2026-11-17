// Start at login (`commands/autostart.rs`, #330). The real backend asks the
// OS; here `cluster.autostart` stands in for the autostart entry.

import type { AreaHandlers, FakeState } from "./state";

export function autostartHandlers(s: FakeState) {
  return {
    cmdAutostartEnabled: () => s.cluster.autostart,
    cmdAutostartSet: (enabled) => {
      s.cluster.autostart = enabled;
      return s.cluster.autostart;
    },
  } satisfies AreaHandlers;
}
