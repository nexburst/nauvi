// The keymap: every keyboard shortcut of the app, as data. The global
// handler (`stores/keyboard.svelte.ts`) dispatches from it and the help
// overlay (`?`) is generated from it, so a new shortcut is one entry here
// plus a case in the handler.

export type Command =
  | "palette"
  | "help"
  | "settings"
  | "focusFilter"
  | "rowDown"
  | "rowUp"
  | "rowFirst"
  | "rowLast"
  | "openRow"
  | "toggleRow"
  | "rowMenu"
  | "deleteRows"
  | "detailTab"
  | "toggleDock"
  | "newLocalShell"
  | "refresh"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "escape";

export interface Key {
  /** `KeyboardEvent.key`, compared case-insensitively for letters with a modifier. */
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean;
  /** The Ctrl key on every platform (Cmd+` switches windows on macOS). */
  ctrl?: boolean;
  shift?: boolean;
  /** Only on macOS (true) or only elsewhere (false). */
  mac?: boolean;
  /**
   * `KeyboardEvent.code`, the physical key, also accepted for `ctrl` keys:
   * where the backtick is a dead key (Spanish, Latin American, German...),
   * Ctrl+that key has another `key` ("Dead", "<", "^") but still this code.
   */
  code?: string;
  /** How the help overlay names the key, when `key` is not what is printed on it. */
  name?: string;
  /**
   * false: this key of an `inTerminal` binding is left to the shell outside
   * macOS (Ctrl+J is LF, which fzf, vim and emacs use; ⌘J never reaches it).
   * "always": left to the shell on every platform (F5 is a key programs
   * like mc and htop use).
   */
  terminal?: false | "always";
}

export interface Binding {
  command: Command;
  keys: Key[];
  /** What the help overlay says it does. */
  label: string;
  group: "General" | "Table" | "Detail panel";
  /** How the help overlay writes the keys, when listing them would be long. */
  display?: string[];
  /** Also fires from text inputs (never from the YAML editor or the terminal). */
  inInputs?: boolean;
  /** Also fires from the terminal, which otherwise keeps every key. */
  inTerminal?: boolean;
  /** Also fires from the YAML editor, which otherwise keeps every key. */
  inEditor?: boolean;
}

const digits = Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1), mod: true }));

export const KEYMAP: Binding[] = [
  {
    command: "palette",
    keys: [
      { key: "k", mod: true },
      { key: "p", mod: true },
    ],
    label: "Command palette (> actions, ns namespaces, ctx contexts)",
    group: "General",
    inInputs: true,
  },
  { command: "help", keys: [{ key: "?" }], label: "Show these shortcuts", group: "General" },
  { command: "settings", keys: [{ key: ",", mod: true }], label: "Settings", group: "General", inInputs: true },
  {
    command: "escape",
    keys: [{ key: "Escape" }],
    label: "Close the palette, menu, dialog or detail panel",
    group: "General",
  },
  { command: "focusFilter", keys: [{ key: "/" }], label: "Focus the table filter", group: "Table" },
  {
    command: "rowDown",
    keys: [{ key: "ArrowDown" }, { key: "j" }],
    label: "Next row",
    group: "Table",
  },
  { command: "rowUp", keys: [{ key: "ArrowUp" }, { key: "k" }], label: "Previous row", group: "Table" },
  { command: "rowFirst", keys: [{ key: "Home" }], label: "First row", group: "Table" },
  { command: "rowLast", keys: [{ key: "End" }], label: "Last row", group: "Table" },
  { command: "openRow", keys: [{ key: "Enter" }], label: "Open the row's details", group: "Table" },
  { command: "toggleRow", keys: [{ key: " " }], label: "Select or unselect the row", group: "Table" },
  {
    command: "rowMenu",
    keys: [{ key: "F10", shift: true }, { key: "ContextMenu" }],
    label: "Open the row's menu",
    group: "Table",
  },
  {
    command: "deleteRows",
    keys: [{ key: "Delete" }, { key: "Backspace", mod: true, mac: true }],
    label: "Delete the selected rows, or the focused one",
    group: "Table",
  },
  {
    command: "detailTab",
    keys: digits,
    display: ["Mod+1…9"],
    label: "Switch detail panel tab",
    group: "Detail panel",
  },
  {
    command: "toggleDock",
    // Mod+J (as in VS Code) for layouts with no Backquote key at all.
    keys: [
      { key: "`", code: "Backquote", ctrl: true },
      { key: "j", mod: true, terminal: false },
    ],
    label: "Show or hide the dock (logs and terminals)",
    group: "General",
    inInputs: true,
    // Like an editor's terminal panel: the one key a shell gives up, so the
    // dock can be hidden from inside it. Ctrl+` would only send a NUL byte.
    inTerminal: true,
  },
  {
    command: "newLocalShell",
    // Shift+` types `~` on a US layout, so that is the key the event has.
    keys: [
      { key: "~", code: "Backquote", ctrl: true, shift: true, name: "`" },
      { key: "j", mod: true, shift: true, terminal: false },
    ],
    label: "New local terminal (kubectl on this machine, at the app's context and namespace)",
    group: "General",
    inInputs: true,
    inTerminal: true,
  },
  {
    command: "refresh",
    // The engine's reload keys (#205), plain and forced: reloading the
    // page would skip the unsaved-edit prompt and drop the dock's tabs.
    keys: [
      { key: "F5", terminal: "always" },
      { key: "F5", mod: true, terminal: "always" },
      { key: "F5", shift: true, terminal: "always" },
      // Ctrl+R is the shell's history search.
      { key: "r", mod: true, terminal: false },
      { key: "r", mod: true, shift: true },
    ],
    display: ["F5", "Mod+R"],
    label: "Refresh",
    group: "General",
    inInputs: true,
    inTerminal: true,
    inEditor: true,
  },
  // Zoom (#207), as in a browser. `+` is Shift+= on many layouts and its
  // own key on others (and on the keypad).
  {
    command: "zoomIn",
    keys: [
      { key: "=", mod: true },
      { key: "+", mod: true },
    ],
    display: ["Mod+="],
    label: "Zoom in",
    group: "General",
    inInputs: true,
    inTerminal: true,
  },
  {
    command: "zoomOut",
    keys: [{ key: "-", mod: true }],
    label: "Zoom out",
    group: "General",
    inInputs: true,
    inTerminal: true,
  },
  {
    command: "zoomReset",
    keys: [{ key: "0", mod: true }],
    label: "Reset the zoom",
    group: "General",
    inInputs: true,
    inTerminal: true,
  },
];

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function matchesKey(e: KeyEventLike, k: Key, mac: boolean): boolean {
  if (k.mac !== undefined && k.mac !== mac) return false;
  if (k.ctrl) {
    if (!e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === k.key) return true;
    // By the physical key, Shift must be as asked: Ctrl+Shift+` is another binding.
    return !!k.code && e.code === k.code && !!k.shift === e.shiftKey;
  }
  const modDown = mac ? e.metaKey : e.ctrlKey;
  const otherDown = mac ? e.ctrlKey : e.metaKey;
  if (!!k.mod !== modDown || otherDown || e.altKey) return false;
  // Shift is part of punctuation like `?`, so only checked when asked for
  // (Shift+F10) or when a plain letter must stay lower case (j, k).
  if (k.shift && !e.shiftKey) return false;
  if (!k.shift && e.shiftKey && (k.key.length > 1 || /[a-z ]/.test(k.key))) return false;
  if (k.mod && k.key.length === 1) return e.key.toLowerCase() === k.key;
  return e.key === k.key;
}

/** The binding `e` triggers, and for `detailTab` the digit's index (0-based). */
export function bindingFor(e: KeyEventLike, mac: boolean): { binding: Binding; index: number } | null {
  for (const binding of KEYMAP) {
    const index = binding.keys.findIndex((k) => matchesKey(e, k, mac));
    if (index >= 0) return { binding, index };
  }
  return null;
}

const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  ArrowDown: "↓",
  ArrowUp: "↑",
  Escape: "Esc",
  ContextMenu: "Menu",
};

/** "Ctrl+K" / "⌘K": one key as the help overlay shows it. */
export function formatKey(k: Key, mac: boolean): string {
  const name = k.name ?? KEY_NAMES[k.key] ?? (k.key.length === 1 ? k.key.toUpperCase() : k.key);
  // macOS writes ⌃⇧⌘K; elsewhere it is Ctrl+Shift+K.
  const parts = mac
    ? [k.ctrl ? "⌃" : "", k.shift ? "⇧" : "", k.mod ? "⌘" : "", name]
    : [k.mod || k.ctrl ? "Ctrl" : "", k.shift ? "Shift" : "", name];
  return parts.filter(Boolean).join(mac ? "" : "+");
}

/** Every way to press `b`, for the help overlay. */
export function formatBinding(b: Binding, mac: boolean): string[] {
  if (b.display) return b.display.map((d) => d.replace("Mod+", mac ? "⌘" : "Ctrl+"));
  // `?` is typed with Shift anyway; lower-case letters read better as typed.
  // On macOS ⌘J comes first: which key ⌃` names depends on the keyboard
  // (left of 1, or next to the left Shift on ISO keyboards).
  const keys = mac ? [...b.keys].sort((x, y) => Number(!!x.ctrl) - Number(!!y.ctrl)) : b.keys;
  return keys
    .filter((k) => k.mac === undefined || k.mac === mac)
    .map((k) => (!k.mod && !k.ctrl && k.key.length === 1 && k.key !== " " ? k.key : formatKey(k, mac)));
}

/** "Ctrl+` or Ctrl+J": a command's keys for a tooltip. */
export function shortcutHint(command: Command, mac: boolean): string {
  const b = KEYMAP.find((x) => x.command === command);
  return b ? formatBinding(b, mac).join(" or ") : "";
}

/** Whether the key `hit` matched goes to the terminal instead of the app. */
export function leftToTerminal(binding: Binding, index: number, mac: boolean): boolean {
  const terminal = binding.keys[index]?.terminal;
  return terminal === "always" || (terminal === false && !mac);
}

/** Where typing goes: shortcuts stay out of the way there. */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (inEditorOrTerminal(el)) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** The YAML editor (CodeMirror) and the terminal (xterm) keep every key. */
export function inEditorOrTerminal(el: Element | null): boolean {
  return !!el?.closest(".cm-editor, .xterm");
}

/** Enter and Space already mean something on these (press, toggle, open). */
export function isActivatable(el: Element | null): boolean {
  return !!el?.closest(
    'button, a[href], input, select, textarea, summary, [role="menuitem"], [role="tab"], [role="option"]',
  );
}
