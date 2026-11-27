// Pure helpers for the remembered settings (`stores/settings.svelte.ts`
// holds them; the backend's `settings.rs` saves them).

import type {
  ContextInfo,
  ContextSettings_Serialize,
  ImageSecuritySettings_Serialize as ImageSecuritySettings,
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
import { orderChanged } from "./columnOrder";
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
  /** Context ids hidden in nauvi (ADR 0007), the whole list. */
  hidden_contexts?: string[];
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
  /** Show the Available tags button by images (#539). */
  registry_tags?: boolean;
  /** The collapsed sidebar sections, the whole list (#383). */
  collapsed_sections?: string[];
  /** The sidebar sections with "More" open, the whole list (#481). */
  open_more_sections?: string[];
  /** Ask AI's CLI (#376): an id, `custom`, or "" for the first found. */
  ask_ai_cli?: string;
  /** Ask AI's custom command (#376). */
  ask_ai_command?: string;
  /** "Let Ask AI open views": `nauvi show` opens views (#548). */
  ask_ai_open_views?: boolean;
  /** The welcome screen was left once (#485). */
  welcomed?: boolean;
  /** How many more starts show the tips strip (#485). */
  tips_left?: number;
  /** The whole image security section (#534). */
  image_security?: ImageSecuritySettings;
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
    hidden_contexts: [],
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
    registry_tags: false,
    collapsed_sections: [],
    open_more_sections: [],
    ask_ai_cli: "",
    ask_ai_command: "",
    ask_ai_open_views: false,
    // What a settings file from before the welcome screen gets (#485); a
    // first run's settings come from the backend.
    welcomed: true,
    tips_left: 0,
    image_security: {
      enabled: false,
      min_severity: "high",
      only_fixable: false,
      excluded_namespaces: [],
      cache_ttl_hours: 24,
    },
  };
}

/** The starts that show the tips strip on a first run (`TIPS_SESSIONS` in settings.rs). */
export const TIPS_SESSIONS = 5;

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
  mode: "normal",
  mode_source: { file: "", given: "", context: "" },
};
export const EMPTY_KIND: KindSettings = {
  sort_key: "",
  sort_desc: false,
  hidden: [],
  shown: [],
  widths: {},
  order: [],
  custom: [],
};

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
  if (patch.hidden_contexts != null) next.hidden_contexts = [...new Set(patch.hidden_contexts.filter(Boolean))];
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
  if (patch.registry_tags != null) next.registry_tags = patch.registry_tags;
  if (patch.collapsed_sections != null)
    next.collapsed_sections = [...new Set(patch.collapsed_sections.filter(Boolean))];
  if (patch.open_more_sections != null)
    next.open_more_sections = [...new Set(patch.open_more_sections.filter(Boolean))];
  if (patch.ask_ai_cli != null) next.ask_ai_cli = patch.ask_ai_cli.trim();
  if (patch.ask_ai_command != null) next.ask_ai_command = patch.ask_ai_command.trim();
  if (patch.ask_ai_open_views != null) next.ask_ai_open_views = patch.ask_ai_open_views;
  if (patch.welcomed != null) next.welcomed = patch.welcomed;
  if (patch.tips_left != null) next.tips_left = Math.max(0, Math.min(TIPS_SESSIONS, patch.tips_left));
  if (patch.image_security != null) next.image_security = patch.image_security;
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

/** What the column chooser needs to know of a column. */
export interface ColumnChoice {
  key: string;
  /** Off until the user turns it on (#378). */
  defaultHidden: boolean;
}

/** Whether `col` shows: an off-by-default column once turned on, any
 *  other until hidden. */
export function columnOn(kind: Pick<KindSettings, "hidden" | "shown">, col: ColumnChoice): boolean {
  return col.defaultHidden ? (kind.shown ?? []).includes(col.key) : !kind.hidden.includes(col.key);
}

/** The change to a kind's settings that turns `col` on or off. */
export function toggleColumn(
  kind: Pick<KindSettings, "hidden" | "shown">,
  col: ColumnChoice,
): Pick<KindSettings, "hidden"> | Pick<KindSettings, "shown"> {
  if (!col.defaultHidden) return { hidden: toggleHidden(kind.hidden, col.key) };
  const shown = kind.shown ?? [];
  return { shown: shown.includes(col.key) ? shown.filter((k) => k !== col.key) : [...shown, col.key] };
}

/** "Reset to default" in the chooser: what the kind shows on a fresh install
 *  (every column but the off-by-default ones, in the kind's order, fitted
 *  to their values). Custom columns stay, shown (#547). */
export const DEFAULT_COLUMNS: Pick<KindSettings, "hidden" | "shown" | "order" | "widths"> = {
  hidden: [],
  shown: [],
  order: [],
  widths: {},
};

/** Whether the user changed which columns of the kind show, their order
 *  or their widths. `cols` in the kind's own order. */
export function columnsChanged(
  kind: Pick<KindSettings, "hidden" | "shown"> & Partial<Pick<KindSettings, "order" | "widths">>,
  cols: readonly ColumnChoice[],
): boolean {
  return (
    cols.some((c) => columnOn(kind, c) === c.defaultHidden) ||
    orderChanged(cols, kind.order ?? []) ||
    Object.keys(kind.widths ?? {}).length > 0
  );
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
