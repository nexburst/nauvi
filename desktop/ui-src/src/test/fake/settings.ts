// Settings (`commands/settings.rs`).

import { applyPatch, EMPTY_CONTEXT } from "../../lib/settings";
import type { SettingsPatch } from "../../lib/settings";
import { copy, saveSettings } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function settingsHandlers(s: FakeState) {
  return {
    cmdGetSettings: () => copy(s.cluster.settings),
    cmdUpdateSettings: (patch) => {
      // The app sends whole values (`SettingsPatch`), like the backend expects.
      const before = s.cluster.settings.contexts;
      const next = applyPatch(s.cluster.settings, patch as SettingsPatch);
      // A patch keeps each context's mode, which has its own command (#338).
      for (const id of Object.keys((patch as SettingsPatch).contexts ?? {})) {
        next.contexts[id] = { ...next.contexts[id], mode: before[id]?.mode ?? "normal" };
      }
      saveSettings(s, next);
      return copy(s.cluster.settings);
    },
    cmdSetContextMode: (id, mode) => {
      if (!id) throw "No context is selected";
      const contexts = s.cluster.settings.contexts;
      saveSettings(s, {
        ...s.cluster.settings,
        contexts: { ...contexts, [id]: { ...EMPTY_CONTEXT, ...contexts[id], mode } },
      });
      return copy(s.cluster.settings);
    },
  } satisfies AreaHandlers;
}
