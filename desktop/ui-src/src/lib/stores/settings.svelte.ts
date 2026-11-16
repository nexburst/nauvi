// The remembered settings: loaded once on start, changed through `update`,
// which applies the change here at once and sends it to the backend (which
// writes the file, debounced).

import { commands } from "../bindings";
import type { ContextSettings, KindSettings, Settings, SettingsPatch } from "../settings";
import {
  applyPatch,
  clampWidth,
  defaultSettings,
  EMPTY_CONTEXT,
  EMPTY_KIND,
  themeAttribute,
} from "../settings";
import { clampZoom, DEFAULT_ZOOM, stepZoom } from "../zoom";

class SettingsStore {
  /** Replaced on every change, never mutated. */
  current = $state.raw<Settings>(defaultSettings());
}
export const settings = new SettingsStore();

/** Read the settings from the backend; the defaults stay if it fails. */
export async function loadSettings() {
  try {
    settings.current = await commands.cmdGetSettings();
  } catch {
    // A broken settings store must not stop the app from starting.
  }
  applyAppearance();
  applyZoom();
}

/** Resolves once the backend has the change (or failed to take it). */
export function updateSettings(patch: SettingsPatch): Promise<void> {
  settings.current = applyPatch(settings.current, patch);
  return commands.cmdUpdateSettings(patch).then(
    () => {},
    () => {
      // Not saved: the change still holds for this session.
    },
  );
}

export function contextSettings(context: string): ContextSettings {
  return settings.current.contexts[context] ?? EMPTY_CONTEXT;
}

export function updateContext(context: string, change: Partial<ContextSettings>): Promise<void> {
  return updateSettings({ contexts: { [context]: { ...contextSettings(context), ...change } } });
}

export function kindSettings(kindId: string): KindSettings {
  return settings.current.kinds[kindId] ?? EMPTY_KIND;
}

export function updateKind(kindId: string, change: Partial<KindSettings>) {
  updateSettings({ kinds: { [kindId]: { ...kindSettings(kindId), ...change } } });
}

/** The detail panel width that fits the window now. */
export function detailWidth(): number {
  return clampWidth(settings.current.detail_width, typeof window === "undefined" ? 1600 : window.innerWidth);
}

/** Remember the dock's height (restored by `startApp`). */
export function setDockHeight(px: number) {
  updateSettings({ dock_height: Math.max(0, Math.round(px)) });
}

/** Set the theme and the panel width on the document. */
export function applyAppearance() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = themeAttribute(settings.current.theme);
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  root.style.setProperty("--detail-width", `${detailWidth()}px`);
}

/** Zoom this window's page as the settings say (#207). */
export function applyZoom() {
  commands.cmdSetZoom(settings.current.zoom).catch(() => {
    // Not zoomed: the page stays as it is, the setting is still remembered.
  });
}

/** Set and remember the page zoom, in percent. */
export function setZoom(percent: number) {
  updateSettings({ zoom: clampZoom(percent) });
  applyZoom();
}

export const zoomIn = () => setZoom(stepZoom(settings.current.zoom, "in"));
export const zoomOut = () => setZoom(stepZoom(settings.current.zoom, "out"));
export const zoomReset = () => setZoom(DEFAULT_ZOOM);
