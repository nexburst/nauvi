// Editor and table preferences (#330): the ranges the backend keeps them in
// (`settings.rs`) and what they turn into.

import type { RowHeight } from "./bindings";

export const DEFAULT_EDITOR_FONT = 12;
export const MIN_EDITOR_FONT = 8;
export const MAX_EDITOR_FONT = 32;

export const DEFAULT_TAB_SIZE = 2;
/** The tab sizes offered in Settings (the backend accepts 1 to 8). */
export const TAB_SIZES = [2, 4, 8];

/** `value` as an editor font size in range (a bad one: the default). */
export function clampEditorFont(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_EDITOR_FONT;
  return Math.round(Math.min(Math.max(value, MIN_EDITOR_FONT), MAX_EDITOR_FONT));
}

/** `value` as a tab size in range (a bad one: the default). */
export function clampTabSize(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_TAB_SIZE;
  return Math.round(Math.min(value, 8));
}

/** How much shorter compact rows are than normal ones, in pixels. */
const COMPACT_LESS = 6;

/** The row height of a table whose normal rows are `normal` px high. */
export function rowHeightPx(normal: number, height: RowHeight): number {
  return height === "compact" ? normal - COMPACT_LESS : normal;
}

export const ROW_HEIGHTS: { value: RowHeight; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "compact", label: "Compact" },
];
