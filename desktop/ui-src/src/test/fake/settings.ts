// Settings (`commands/settings.rs`).

import { applyPatch } from "../../lib/settings";
import type { SettingsPatch } from "../../lib/settings";
import { copy, saveSettings } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function settingsHandlers(s: FakeState) {
  return {
    cmdGetSettings: () => copy(s.cluster.settings),
    cmdUpdateSettings: (patch) => {
      // The app sends whole values (`SettingsPatch`), like the backend expects.
      saveSettings(s, applyPatch(s.cluster.settings, patch as SettingsPatch));
      return copy(s.cluster.settings);
    },
  } satisfies AreaHandlers;
}
