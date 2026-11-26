// The first run (#485): whether the tips strip shows this session, and
// remembering that the welcome screen was seen.

import { isMainWindow } from "../window";
import { settings, updateSettings } from "./settings.svelte";

export const tips = $state({ show: false });

/** Started with the app: the first few sessions of the main window show the tips strip. */
export async function startTips() {
  const left = settings.current.tips_left;
  if (!isMainWindow() || left <= 0) return;
  tips.show = true;
  await updateSettings({ tips_left: left - 1 });
}

/** The strip's close button: no more tips, in this session or later ones. */
export function dismissTips() {
  tips.show = false;
  void updateSettings({ tips_left: 0 });
}

/** The welcome screen was left: the next start opens where this one ends. */
export function leaveWelcome() {
  if (!settings.current.welcomed) void updateSettings({ welcomed: true });
}
