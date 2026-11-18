// The global keyboard handler: turns a keydown into a command from the
// keymap (`lib/keys.ts`) and runs it on whatever is on screen. Components
// with keyboard behaviour (the resource table, the detail tabs) register a
// handle here while mounted.

import type { ResourceKind } from "../bindings";
import type { ActionTarget } from "../actions";
import type { Row } from "../columns";
import type { Command } from "../keys";
import { bindingFor, inEditorOrTerminal, isActivatable, isMacPlatform, isTextEntry, leftToTerminal } from "../keys";
import { actionUi } from "./actions.svelte";
import { apps, selectApplication } from "./applications.svelte";
import { helm, selectRelease } from "./helm.svelte";
import { catalog } from "./catalog.svelte";
import { charts, selectChart } from "./helmCharts.svelte";
import { createUi } from "./create.svelte";
import { closeDetail, detail } from "./detail.svelte";
import { toggleDock } from "./dock.svelte";
import { chart, closeChart, toggleChart } from "./chart.svelte";
import { openLocalShell } from "./localShell";
import { zoomIn, zoomOut, zoomReset } from "./settings.svelte";
import { unsaved } from "./unsaved.svelte";
import { refresh } from "./app.svelte";
import { goBack, goForward } from "./navigation.svelte";

export const keyboard = $state({
  palette: false,
  /** What the palette's search starts with when it opens. */
  paletteQuery: "",
  help: false,
  settings: false,
  /** Context menus open (they handle their own keys meanwhile). */
  menus: 0,
});

export type RowMove = "next" | "prev" | "first" | "last";

/** What the keyboard can do with the resource table on screen. */
export interface TableHandle {
  kind: ResourceKind;
  move(to: RowMove): void;
  openFocused(): void;
  toggleFocused(): void;
  menuForFocused(): void;
  deleteRows(): void;
  /** Every row of the table (not only the filtered ones), for the palette. */
  rows(): Row[];
  /** The checked rows, else the focused row, else the one in the detail panel. */
  actionTargets(): { targets: ActionTarget[]; row: Row | null };
  /** Give the table the keyboard focus (when a dialog or the palette closes). */
  focus(): void;
}

export interface TabsHandle {
  count(): number;
  select(index: number): void;
}

let table: TableHandle | null = null;
let tabs: TabsHandle | null = null;

/** Register the table on screen; returns the unregister function. */
export function registerTable(handle: TableHandle): () => void {
  table = handle;
  return () => {
    if (table === handle) table = null;
  };
}

/** Opens a terminal's search bar if `target` is in that (shown) terminal. */
export type TerminalSearchHandle = (target: Element | null) => boolean;

const terminalSearches = new Set<TerminalSearchHandle>();

/** Register a mounted terminal's search (#222); returns the unregister function. */
export function registerTerminalSearch(handle: TerminalSearchHandle): () => void {
  terminalSearches.add(handle);
  return () => terminalSearches.delete(handle);
}

function openTerminalSearch(target: Element | null): boolean {
  for (const open of terminalSearches) if (open(target)) return true;
  return false;
}

export function activeTable(): TableHandle | null {
  return table;
}

/** Register the detail panel's tabs (Ctrl/Cmd+1…9); returns the unregister function. */
export function registerTabs(handle: TabsHandle): () => void {
  tabs = handle;
  return () => {
    if (tabs === handle) tabs = null;
  };
}

export function openPalette(query = "") {
  keyboard.help = false;
  keyboard.paletteQuery = query;
  keyboard.palette = true;
}

export function closePalette() {
  keyboard.palette = false;
}

export function openHelp() {
  keyboard.palette = false;
  keyboard.help = true;
}

export function closeHelp() {
  keyboard.help = false;
}

export function openSettings() {
  keyboard.palette = false;
  keyboard.help = false;
  keyboard.settings = true;
}

export function closeSettings() {
  keyboard.settings = false;
}

/** A menu or a dialog has the keyboard (each handles its own Esc). */
function modalOpen(): boolean {
  return (
    keyboard.menus > 0 ||
    actionUi.request !== null ||
    helm.request !== null ||
    charts.deploy !== null ||
    createUi.open ||
    unsaved.asking ||
    catalog.settingsFor !== null
  );
}

const mac = isMacPlatform();

const ZOOM: Partial<Record<Command, () => void>> = { zoomIn, zoomOut, zoomReset };

/**
 * The window's keydown handler (capture phase, so it sees the state before
 * a menu or dialog reacts to the same key).
 */
export function handleKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const hit = bindingFor(e, mac);
  if (!hit) return;
  // Zoom (#207) works everywhere: over menus and dialogs, in the editor and the terminal.
  const zoom = ZOOM[hit.binding.command];
  if (zoom) return done(e, zoom);
  const target = e.target instanceof Element ? e.target : document.activeElement;
  const inXterm = !!target?.closest(".xterm");
  const allowedHere = inXterm ? hit.binding.inTerminal : hit.binding.inEditor;
  if (inEditorOrTerminal(target) && !allowedHere) return;
  if (inXterm && leftToTerminal(hit.binding, hit.index, mac)) return;
  if (isTextEntry(target) && !hit.binding.inInputs) return;
  if (hit.binding.command === "refresh") {
    // Never the engine's reload (#205); behind a dialog, nothing more.
    e.preventDefault();
    if (!modalOpen()) done(e, refresh);
    return;
  }
  if (modalOpen()) return;

  const command = hit.binding.command;
  // The palette and the help overlay sit on top: they take only their own keys.
  if (keyboard.palette) {
    if (command === "palette") done(e, closePalette);
    return;
  }
  if (keyboard.help) {
    if (command === "escape" || command === "help") done(e, closeHelp);
    return;
  }
  if (keyboard.settings) {
    if (command === "escape" || command === "settings") done(e, closeSettings);
    return;
  }

  if (chart.open && command === "escape") return done(e, closeChart);

  switch (command) {
    case "chart":
      return done(e, toggleChart);
    case "palette":
      return done(e, openPalette);
    case "help":
      return done(e, openHelp);
    case "settings":
      return done(e, openSettings);
    case "escape":
      if (detail.target) done(e, closeDetail);
      else if (helm.selected) done(e, () => selectRelease(null));
      else if (charts.selected) done(e, () => selectChart(null));
      else if (apps.selected) done(e, () => selectApplication(null));
      return;
    case "focusFilter": {
      const filter = document.getElementById("table-filter");
      if (filter) done(e, () => filter.focus());
      return;
    }
    case "rowDown":
    case "rowUp":
    case "rowFirst":
    case "rowLast": {
      const to = ({ rowDown: "next", rowUp: "prev", rowFirst: "first", rowLast: "last" } as const)[command];
      if (table) done(e, () => table?.move(to));
      return;
    }
    case "openRow":
    case "toggleRow":
      // Enter and Space keep their meaning on buttons, checkboxes and links.
      if (!table || isActivatable(target)) return;
      return done(e, () => (command === "openRow" ? table?.openFocused() : table?.toggleFocused()));
    case "rowMenu":
      if (table) done(e, () => table?.menuForFocused());
      return;
    case "deleteRows":
      if (table) done(e, () => table?.deleteRows());
      return;
    case "toggleDock":
      return done(e, toggleDock);
    case "newLocalShell":
      return done(e, openLocalShell);
    case "terminalSearch":
      // Only from a terminal (or its search bar): elsewhere ⌘F is left alone.
      if (openTerminalSearch(target)) done(e, () => {});
      return;
    case "detailTab":
      if (tabs && hit.index < tabs.count()) done(e, () => tabs?.select(hit.index));
      return;
    case "back":
      return done(e, goBack);
    case "forward":
      return done(e, goForward);
  }
}

/** `MouseEvent.button` of the mouse's back and forward buttons (4 and 5). */
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

/** Whether the back/forward buttons may move now: not behind a dialog or overlay. */
function navigationFree(): boolean {
  return !modalOpen() && !keyboard.palette && !keyboard.help && !keyboard.settings;
}

/**
 * The mouse's back and forward buttons (#223), anywhere in the window.
 * Returns the function that stops listening.
 */
export async function listenMouseButtons(): Promise<() => void> {
  const isNav = (e: MouseEvent) => e.button === MOUSE_BACK || e.button === MOUSE_FORWARD;
  // The engine's own back/forward would leave the app's page.
  const onDown = (e: MouseEvent) => {
    if (isNav(e)) e.preventDefault();
  };
  const onUp = (e: MouseEvent) => {
    if (!isNav(e)) return;
    e.preventDefault();
    if (navigationFree()) (e.button === MOUSE_BACK ? goBack : goForward)();
  };
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("mouseup", onUp, true);
  return () => {
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mouseup", onUp, true);
  };
}

function done(e: KeyboardEvent, fn: () => void) {
  e.preventDefault();
  e.stopPropagation();
  fn();
}
