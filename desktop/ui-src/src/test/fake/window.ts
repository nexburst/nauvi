// Windows (`commands/window.rs`).

import { applyPatch } from "../../lib/settings";
import { saveSettings } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function windowHandlers(s: FakeState) {
  return {
    cmdOpenWindow: (context) => {
      // The real backend opens a window; here it only remembers it, as the
      // backend does in the settings.
      saveSettings(s, applyPatch(s.cluster.settings, { windows: [...s.cluster.settings.windows, context] }));
      return null;
    },
  } satisfies AreaHandlers;
}
