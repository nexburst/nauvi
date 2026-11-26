// In-app updates (#30): the automatic check (main window only: on start,
// then every 12 hours and on a wake, #540), the check from Settings and the
// palette, and the install, which only ever starts from a click on "Install
// and restart".

import { openUrl } from "@tauri-apps/plugin-opener";
import { untrack } from "svelte";
import { commands, events } from "../bindings";
import type { UpdateCheck, UpdateProgress } from "../bindings";
import { CHECK_EVERY_MS, dueOnWake, nextCheckIn } from "../updateSchedule";
import { watchWake } from "../wake";
import { isMainWindow, thisWindow } from "../window";
import { settings } from "./settings.svelte";

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

/** When a check last asked for the latest release (null: none yet; a skipped check does not count). */
let lastCheck: number | null = null;

/**
 * Check for a newer release. `startup`: an automatic check (on start, the
 * timer or a wake), which the backend skips when Settings turn it off (and
 * in debug builds). `announce`:
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
    if (updates.check.status !== "skipped") lastCheck = Date.now();
  } catch (e) {
    lastCheck = Date.now();
    updates.checkError = String(e);
    // A failed automatic check stays quiet: no network is no news.
    if (startup) updates.announce = false;
  } finally {
    updates.checking = false;
  }
}

/** The check on start, then the periodic ones: only the main window runs them. */
export async function startupCheck(): Promise<void> {
  if (!isMainWindow()) return;
  await checkForUpdates(true);
  startAutoChecks();
}

interface WakeTargets {
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
}

/** The periodic check's interval; QA shortens it (`__nauviUpdateEvery`). */
let every = CHECK_EVERY_MS;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopWake: (() => void) | null = null;
let stopEffect: (() => void) | null = null;
let wakeTargets: WakeTargets | null = null;

function schedule(delay = nextCheckIn(every)) {
  clearTimeout(timer);
  timer = setTimeout(() => void autoCheck(), delay);
}

function autoCheck(): Promise<void> {
  schedule();
  return checkForUpdates(true);
}

function resume(turnedOn: boolean) {
  if (wakeTargets) {
    stopWake ??= watchWake(wakeTargets, () => {
      if (dueOnWake(lastCheck, Date.now(), every)) void autoCheck();
    });
  }
  // Turned on in Settings: check now unless a check asked recently.
  if (turnedOn && dueOnWake(lastCheck, Date.now(), every)) void autoCheck();
  else schedule();
}

function pause() {
  clearTimeout(timer);
  timer = undefined;
  stopWake?.();
  stopWake = null;
}

/**
 * Check every 12 hours (± 1 h) and on a wake when the last check is older,
 * while "Check for updates automatically" is on; stop while it is off.
 */
export function startAutoChecks(targets: WakeTargets | null = typeof window === "undefined" ? null : { win: window, doc: document }) {
  if (stopEffect) return;
  wakeTargets = targets;
  let on: boolean | null = null;
  stopEffect = $effect.root(() => {
    $effect(() => {
      const next = settings.current.check_updates;
      if (next === on) return;
      const turnedOn = on !== null;
      on = next;
      untrack(() => (next ? resume(turnedOn) : pause()));
    });
  });
  // The QA hook (desktop/e2e/qa/area-5-updater): a shorter interval from
  // now on, and optionally a different wait until the next timer check.
  if (typeof window !== "undefined") {
    const w = window as unknown as { __nauviUpdateEvery?: (ms: number, nextMs?: number) => void };
    w.__nauviUpdateEvery = (ms, nextMs) => {
      every = Math.max(1_000, ms);
      if (on) schedule(nextMs ?? nextCheckIn(every));
    };
  }
}

/** Stops the periodic checks (tests). */
export function stopAutoChecks() {
  pause();
  stopEffect?.();
  stopEffect = null;
  lastCheck = null;
  every = CHECK_EVERY_MS;
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
