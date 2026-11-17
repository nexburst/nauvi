// Pure helpers for the remembered settings (`stores/settings.svelte.ts`
// holds them; the backend's `settings.rs` saves them).

import type {
  ContextInfo,
  ContextSettings_Serialize,
  KindSettings_Serialize,
  LogDefaults_Serialize,
  RowHeight,
  Settings_Serialize,
  Theme,
  TimeZone,
} from "./bindings";
import { clampEditorFont, clampTabSize, DEFAULT_EDITOR_FONT, DEFAULT_TAB_SIZE } from "./preferences";
import { clampIdleMinutes, DEFAULT_IDLE_MINUTES } from "./idle";
import { normalizeHistory } from "./searchHistory";
import type { SearchHistory } from "./searchHistory";
import type { Sort } from "./view";
import { clampTerminalFont, clampZoom, DEFAULT_TERMINAL_FONT, DEFAULT_ZOOM } from "./zoom";

// The backend fills in missing fields, so what it sends always has them all.
export type Settings = Settings_Serialize;
export type ContextSettings = ContextSettings_Serialize;
export type KindSettings = KindSettings_Serialize;
export type LogDefaults = LogDefaults_Serialize;

/** A change to the settings (`cmd_update_settings`), with whole values. */
export interface SettingsPatch {
  last_context?: string;
  theme?: Theme;
  logs?: LogDefaults;
  check_updates?: boolean;
  detail_width?: number;
  dock_height?: number;
  /** Replaces just these contexts' entries. */
  contexts?: Record<string, ContextSettings>;
  /** Replaces just these kinds' entries. */
  kinds?: Record<string, KindSettings>;
  /** The extra windows' contexts (the backend keeps them up to date). */
  windows?: string[];
  /** Pinned context ids, in order (#78). */
  favourites?: string[];
  /** Page zoom in percent (#207). */
  zoom?: number;
  /** Terminal font size in pixels (#207). */
  terminal_font_size?: number;
  /** YAML editor font size in pixels (#330). */
  editor_font_size?: number;
  /** YAML editor tab size in columns (#330). */
  editor_tab_size?: number;
  /** The zone times are shown in (#330). */
  time_zone?: TimeZone;
  /** Table row height (#330). */
  row_height?: RowHeight;
  /** Disconnect idle background clusters after this many minutes, 0 never (#333). */
  idle_disconnect_minutes?: number;
  /** The table filter's whole search history (#219). */
  searches?: SearchHistory;
  /** Offer a kubectl matching the cluster in local terminals (#331). */
  kubectl_match?: boolean;
}

/** What the app uses until the backend answers (and if it never does). */
export function defaultSettings(): Settings {
  return {
    version: 1,
    last_context: "",
    theme: "system",
    logs: { tail: "200", timestamps: false, wrap: false },
    check_updates: true,
    detail_width: DEFAULT_DETAIL_WIDTH,
    dock_height: 0,
    contexts: {},
    kinds: {},
    windows: [],
    kubeconfig_sources: [],
    favourites: [],
    zoom: DEFAULT_ZOOM,
    terminal_font_size: DEFAULT_TERMINAL_FONT,
    editor_font_size: DEFAULT_EDITOR_FONT,
    editor_tab_size: DEFAULT_TAB_SIZE,
    time_zone: "local",
    row_height: "normal",
    idle_disconnect_minutes: DEFAULT_IDLE_MINUTES,
    forwards: {},
    searches: { recent: [], starred: [] },
    kubectl_match: false,
  };
}

export const DEFAULT_DETAIL_WIDTH = 420;
export const MIN_DETAIL_WIDTH = 320;
/** The panel may take at most this share of the window. */
export const MAX_DETAIL_SHARE = 0.75;

/** The log viewer's tail options; a remembered value outside them falls back. */
export const TAIL_OPTIONS = ["100", "200", "1000", "5000", "all"];

export const EMPTY_CONTEXT: ContextSettings = {
  view: "",
  namespaces: [],
  typed_namespaces: [],
  prometheus: "",
  display_name: "",
  color: "",
  default_namespace: "",
  shell_cwd: "",
  last_used: 0,
  hide_metrics: false,
};
export const EMPTY_KIND: KindSettings = { sort_key: "", sort_desc: false, hidden: [] };

/** What is wrong with a Prometheus Service typed in Settings ("" if nothing):
 *  empty (detect), `off`, or `namespace/service[:port]`. */
export function prometheusSettingError(value: string): string {
  const v = value.trim();
  if (v === "" || v.toLowerCase() === "off") return "";
  if (/^[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+(:[A-Za-z0-9.-]+)?$/.test(v)) return "";
  return "Use namespace/service:port, for example monitoring/prometheus-k8s:web.";
}

/** `settings` with `patch` applied, the way the backend applies it. */
export function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  const next: Settings = { ...settings };
  if (patch.last_context != null) next.last_context = patch.last_context;
  if (patch.theme != null) next.theme = patch.theme;
  if (patch.logs != null) next.logs = patch.logs;
  if (patch.check_updates != null) next.check_updates = patch.check_updates;
  if (patch.detail_width != null) next.detail_width = patch.detail_width;
  if (patch.dock_height != null) next.dock_height = patch.dock_height;
  if (patch.contexts != null) next.contexts = { ...settings.contexts, ...patch.contexts };
  if (patch.kinds != null) next.kinds = { ...settings.kinds, ...patch.kinds };
  if (patch.windows != null) next.windows = patch.windows;
  if (patch.favourites != null) next.favourites = patch.favourites;
  if (patch.zoom != null) next.zoom = clampZoom(patch.zoom);
  if (patch.terminal_font_size != null) next.terminal_font_size = clampTerminalFont(patch.terminal_font_size);
  if (patch.editor_font_size != null) next.editor_font_size = clampEditorFont(patch.editor_font_size);
  if (patch.editor_tab_size != null) next.editor_tab_size = clampTabSize(patch.editor_tab_size);
  if (patch.time_zone != null) next.time_zone = patch.time_zone;
  if (patch.row_height != null) next.row_height = patch.row_height;
  if (patch.idle_disconnect_minutes != null)
    next.idle_disconnect_minutes = clampIdleMinutes(patch.idle_disconnect_minutes);
  if (patch.searches != null) next.searches = normalizeHistory(patch.searches);
  if (patch.kubectl_match != null) next.kubectl_match = patch.kubectl_match;
  return next;
}

/** The context to start in: the remembered one if it still exists. */
export function contextToRestore(
  remembered: string,
  contexts: readonly Pick<ContextInfo, "name" | "current">[],
): string | null {
  if (!remembered) return null;
  const found = contexts.find((c) => c.name === remembered);
  return found && !found.current ? remembered : null;
}

/**
 * The namespaces to restore, or `null` to use the default scope. When
 * namespaces can be listed, ones that no longer exist are dropped.
 */
export function namespacesToRestore(
  remembered: readonly string[],
  listed: readonly string[],
  forbidden: boolean,
): string[] | null {
  if (remembered.length === 0) return null;
  const kept = forbidden ? [...remembered] : remembered.filter((ns) => listed.includes(ns));
  return kept.length > 0 ? kept : null;
}

/** The remembered sort of a kind's table, if any. */
export function sortOf(kind: KindSettings | undefined): Sort | null {
  return kind?.sort_key ? { key: kind.sort_key, dir: kind.sort_desc ? "desc" : "asc" } : null;
}

export function withSort(kind: KindSettings | undefined, sort: Sort | null): KindSettings {
  return { ...(kind ?? EMPTY_KIND), sort_key: sort?.key ?? "", sort_desc: sort?.dir === "desc" };
}

/** Columns that cannot be hidden. */
export const ALWAYS_SHOWN = ["name"];

/** `hidden` with `key` shown or hidden. */
export function toggleHidden(hidden: readonly string[], key: string): string[] {
  if (ALWAYS_SHOWN.includes(key)) return [...hidden];
  return hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
}

/** The panel width, kept within what fits the window. */
export function clampWidth(width: number, windowWidth: number): number {
  const max = Math.max(MIN_DETAIL_WIDTH, Math.floor(windowWidth * MAX_DETAIL_SHARE));
  if (!Number.isFinite(width) || width <= 0) return Math.min(DEFAULT_DETAIL_WIDTH, max);
  return Math.round(Math.min(Math.max(width, MIN_DETAIL_WIDTH), max));
}

/** The `data-theme` to set on `<html>`: `null` follows the system. */
export function themeAttribute(theme: Theme): "light" | "dark" | null {
  return theme === "system" ? null : theme;
}
