// In-app updates (#30): the check on start (main window only), the check
// from Settings and the palette, and the install, which only ever starts
// from a click on "Install and restart".

import { openUrl } from "@tauri-apps/plugin-opener";
import { commands, events } from "../bindings";
import type { UpdateCheck, UpdateProgress } from "../bindings";
import { isMainWindow, thisWindow } from "../window";

class UpdateStore {
  /** The last check's result (null: none yet). */
  check = $state.raw<UpdateCheck | null>(null);
  checking = $state(false);
  /** The last check failed with this (empty: it did not). */
  checkError = $state("");
  /** A check the user asked for from the palette: show its result in the banner. */
  announce = $state(false);
  /** The version whose banner was closed this session. */
  dismissed = $state("");
  installing = $state(false);
  progress = $state.raw<UpdateProgress | null>(null);
  installError = $state("");
}
export const updates = new UpdateStore();

/**
 * Check for a newer release. `startup`: the check on start, which the
 * backend skips when Settings turn it off (and in debug builds). `announce`:
 * also show "up to date" or the error in the banner (the palette has no
 * other place to say it).
 */
export async function checkForUpdates(startup: boolean, announce = false): Promise<void> {
  if (updates.checking) return;
  updates.checking = true;
  updates.announce = announce;
  updates.checkError = "";
  // Asking again brings back a banner closed earlier.
  if (!startup) updates.dismissed = "";
  try {
    updates.check = await commands.cmdUpdateCheck(startup);
  } catch (e) {
    updates.checkError = String(e);
    // A failed check on start stays quiet: no network is no news.
    if (startup) updates.announce = false;
  } finally {
    updates.checking = false;
  }
}

/** The check on start: only the main window runs it. */
export function startupCheck(): Promise<void> {
  if (!isMainWindow()) return Promise.resolve();
  return checkForUpdates(true);
}

/** Download, install and restart. Progress arrives as `update-progress` events. */
export async function installUpdate(): Promise<void> {
  if (updates.installing || !updates.check?.can_install) return;
  updates.installing = true;
  updates.installError = "";
  updates.progress = { phase: "downloading", downloaded: 0, total: 0 };
  try {
    // On success the app restarts into the new version.
    await commands.cmdUpdateInstall();
  } catch (e) {
    updates.installError = String(e);
    updates.installing = false;
    updates.progress = null;
  }
}

export function dismissUpdate() {
  updates.dismissed = updates.check?.version ?? "";
  updates.announce = false;
}

export function dismissAnnouncement() {
  updates.announce = false;
}

export function openReleasePage() {
  const url = updates.check?.release_url;
  if (url) void openUrl(url);
}

export function listenUpdates(): Promise<() => void> {
  return events.updateProgress(thisWindow()).listen((e) => {
    if (updates.installing) updates.progress = e.payload;
  });
}
