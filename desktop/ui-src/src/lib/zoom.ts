// Page zoom and terminal font size (#207): the steps Mod+= / Mod+- go
// through, and the ranges the backend keeps the settings in (`settings.rs`).

/** The zoom levels, in percent, as browsers step through them. */
export const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
export const DEFAULT_ZOOM = 100;

export const DEFAULT_TERMINAL_FONT = 12;
export const MIN_TERMINAL_FONT = 8;
export const MAX_TERMINAL_FONT = 32;

/** The next zoom step from `current` (which may sit between steps). */
export function stepZoom(current: number, dir: "in" | "out"): number {
  if (dir === "in") return ZOOM_STEPS.find((z) => z > current) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < current) ?? ZOOM_STEPS[0];
}

/** `value` as a zoom the backend accepts (a remembered odd value is kept). */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ZOOM;
  return Math.round(Math.min(Math.max(value, ZOOM_STEPS[0]), ZOOM_STEPS[ZOOM_STEPS.length - 1]));
}

/** `value` as a terminal font size in range (a bad one: the default). */
export function clampTerminalFont(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TERMINAL_FONT;
  return Math.round(Math.min(Math.max(value, MIN_TERMINAL_FONT), MAX_TERMINAL_FONT));
}
