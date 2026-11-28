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
  | "rowLogs"
  | "rowShell"
  | "rowEdit"
  | "rowRestart"
  | "rowPrompt"
  | "rowKill"
  | "rowPreviousLogs"
  | "rowForward"
  | "rowOwner"
  | "rowNode"
  | "markRange"
  | "clearMarks"
  | "sortBy"
  | "commandMode"
  | "problemsOnly"
  | "detailTab"
  | "toggleDock"
  | "chart"
  | "berth"
  | "keepBerth"
  | "widen"
  | "newLocalShell"
  | "refresh"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "terminalSearch"
  | "back"
  | "forward"
  | "escape";

export interface Key {
  /** `KeyboardEvent.key`, compared case-insensitively for letters with a modifier. */
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean;
  /** The Ctrl key on every platform (Cmd+` switches windows on macOS). */
  ctrl?: boolean;
  shift?: boolean;
  /** Alt (Option on macOS). */
  alt?: boolean;
  /** Only on macOS (true) or only elsewhere (false). */
  mac?: boolean;
  /**
   * `KeyboardEvent.code`, the physical key, also accepted for `ctrl` keys:
   * where the backtick is a dead key (Spanish, Latin American, German...),
   * Ctrl+that key has another `key` ("Dead", "<", "^") but still this code.
   * For a `mod` letter it is accepted only when the event's `key` is not a
   * Latin letter (Cyrillic, Greek, Hebrew... layouts), so Dvorak or AZERTY
   * keep the letter printed on the key.
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
  /**
   * The "k9s keys" setting (#575): true, this key only while it is on;
   * false, only while it is off (the key it takes over).
   */
  k9s?: boolean;
}

export interface Binding {
  command: Command;
  keys: Key[];
  /** What the help overlay says it does. */
  label: string;
  group: "General" | "Table" | "Detail panel" | "Terminal";
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
    // With the k9s keys on, Ctrl+K kills a pod outside macOS (⌘K stays).
    keys: [
      { key: "k", mod: true, mac: true },
      { key: "k", mod: true, mac: false, k9s: false },
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
  { command: "chart", keys: [{ key: "g" }], label: "Kinds: type a kubectl name, Enter opens it", group: "General" },
  {
    command: "berth",
    keys: Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1) })),
    display: ["1…9"],
    label: "Go to a berth (1 is the Overview)",
    group: "General",
  },
  { command: "keepBerth", keys: [{ key: "p" }], label: "Keep this view in a berth, or let it go", group: "General" },
  { command: "widen", keys: [{ key: "w" }], label: "Give the object the whole sheet, or the table back", group: "Detail panel" },
  {
    command: "focusFilter",
    keys: [{ key: "/" }],
    label: "Focus the table filter (then Enter, Esc or ↓: back to the rows)",
    group: "Table",
  },
  {
    command: "rowDown",
    keys: [{ key: "ArrowDown" }, { key: "j" }],
    label: "Next row",
    group: "Table",
  },
  { command: "rowUp", keys: [{ key: "ArrowUp" }, { key: "k" }], label: "Previous row", group: "Table" },
  { command: "rowFirst", keys: [{ key: "Home" }], label: "First row", group: "Table" },
  { command: "rowLast", keys: [{ key: "End" }], label: "Last row", group: "Table" },
  {
    command: "openRow",
    keys: [{ key: "Enter" }, { key: "d" }],
    label: "Open the row's details (d: describe, as in k9s)",
    group: "Table",
  },
  { command: "toggleRow", keys: [{ key: " " }], label: "Select or unselect the row", group: "Table" },
  // k9s (#575): the real Ctrl key on macOS too.
  {
    command: "markRange",
    keys: [{ key: " ", ctrl: true }],
    label: "Select every row from the last selected one to this one",
    group: "Table",
  },
  {
    command: "clearMarks",
    keys: [{ key: "\\", ctrl: true, code: "Backslash" }],
    label: "Clear the selection",
    group: "Table",
  },
  {
    command: "rowMenu",
    keys: [{ key: "F10", shift: true }, { key: "ContextMenu" }],
    label: "Open the row's menu",
    group: "Table",
  },
  {
    command: "deleteRows",
    keys: [{ key: "Delete" }, { key: "Backspace", mod: true, mac: true }, { key: "d", ctrl: true }],
    label: "Delete the selected rows, or the focused one (asks first)",
    group: "Table",
  },
  { command: "rowPrompt", keys: [{ key: "a" }], label: "Copy a prompt about the row, for your own agent", group: "Table" },
  { command: "problemsOnly", keys: [{ key: "z" }], label: "Only the rows that need attention, or all again", group: "Table" },
  { command: "rowLogs", keys: [{ key: "l" }], label: "Logs of the row (a pod or a workload)", group: "Table" },
  { command: "rowShell", keys: [{ key: "s" }], label: "Shell in the row's pod", group: "Table" },
  { command: "rowEdit", keys: [{ key: "e" }, { key: "y" }], label: "Edit the row's YAML", group: "Table" },
  {
    command: "rowRestart",
    keys: [{ key: "R", shift: true }, { key: "r" }],
    label: "Restart the row's workload (asks first)",
    group: "Table",
  },
  {
    command: "rowKill",
    keys: [{ key: "k", ctrl: true, k9s: true }],
    label: "Kill: force delete the row's pod (asks first)",
    group: "Table",
  },
  {
    command: "rowPreviousLogs",
    keys: [{ key: "L", shift: true, k9s: true }],
    label: "Logs of the pod's previous run",
    group: "Table",
  },
  { command: "rowForward", keys: [{ key: "F", shift: true }], label: "Port-forward the row", group: "Table" },
  { command: "rowOwner", keys: [{ key: "J", shift: true }], label: "Jump to the row's owner", group: "Table" },
  { command: "rowNode", keys: [{ key: "o" }], label: "Open the pod's node", group: "Table" },
  {
    command: "sortBy",
    // In SORT_KEYS' order.
    keys: [
      { key: "C", shift: true },
      { key: "M", shift: true },
      { key: "N", shift: true },
      { key: "A", shift: true },
      { key: "S", shift: true },
    ],
    display: ["Shift+C M N A S"],
    label: "Sort by CPU, memory, name, age or status (again: the other way)",
    group: "Table",
  },
  {
    command: "commandMode",
    keys: [{ key: ":" }],
    label: "Go to a kind, as k9s's command mode (:pods, :deploy)",
    group: "General",
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
  {
    command: "terminalSearch",
    // Ctrl+F stays the shell's (forward-char in bash and emacs, page down
    // in vim and less); ⌘F never reaches it. Ctrl+Shift+F as in GNOME
    // Terminal, Konsole and Windows Terminal.
    keys: [
      { key: "f", mod: true, shift: true, mac: false, code: "KeyF" },
      { key: "f", mod: true, mac: true, code: "KeyF" },
    ],
    label: "Search the terminal's output (from the terminal)",
    group: "Terminal",
    inInputs: true,
    inTerminal: true,
  },
  // Back/forward (#223), as in a browser. Not from text fields, the editor
  // or the terminal, where Alt+arrows move by word.
  {
    command: "back",
    keys: [
      { key: "ArrowLeft", alt: true, mac: false },
      { key: "[", mod: true, mac: true },
    ],
    label: "Back to the previous view, namespaces or object (also mouse button 4)",
    group: "General",
  },
  {
    command: "forward",
    keys: [
      { key: "ArrowRight", alt: true, mac: false },
      { key: "]", mod: true, mac: true },
    ],
    label: "Forward again (also mouse button 5)",
    group: "General",
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

/** The column each `sortBy` key sorts by. */
export const SORT_KEYS = ["cpu", "memory", "name", "age", "status"] as const;

/** Whether key `k` is live: its platform, and the k9s keys setting. */
function keyLive(k: Key, mac: boolean, k9s: boolean): boolean {
  return (k.mac === undefined || k.mac === mac) && (k.k9s === undefined || k.k9s === k9s);
}

function matchesKey(e: KeyEventLike, k: Key, mac: boolean): boolean {
  if (k.ctrl) {
    if (!e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === k.key) return true;
    // By the physical key, Shift must be as asked: Ctrl+Shift+` is another binding.
    return !!k.code && e.code === k.code && !!k.shift === e.shiftKey;
  }
  const modDown = mac ? e.metaKey : e.ctrlKey;
  const otherDown = mac ? e.ctrlKey : e.metaKey;
  if (!!k.mod !== modDown || otherDown || !!k.alt !== e.altKey) return false;
  // Shift is part of punctuation like `?`, so only checked when asked for
  // (Shift+F10) or when a plain letter must stay lower case (j, k).
  if (k.shift && !e.shiftKey) return false;
  if (!k.shift && e.shiftKey && (k.key.length > 1 || /[a-z ]/.test(k.key))) return false;
  if (k.mod && k.key.length === 1) {
    if (e.key.toLowerCase() === k.key) return true;
    // A layout without Latin letters: by the physical key (see `code`).
    return !!k.code && e.code === k.code && !/^[a-z]$/i.test(e.key);
  }
  return e.key === k.key;
}

/** The binding `e` triggers, and for `detailTab` the digit's index (0-based). */
export function bindingFor(
  e: KeyEventLike,
  mac: boolean,
  k9s = false,
): { binding: Binding; index: number } | null {
  for (const binding of KEYMAP) {
    const index = binding.keys.findIndex((k) => keyLive(k, mac, k9s) && matchesKey(e, k, mac));
    if (index >= 0) return { binding, index };
  }
  return null;
}

const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  ContextMenu: "Menu",
};

/** "Ctrl+K" / "⌘K": one key as the help overlay shows it. */
export function formatKey(k: Key, mac: boolean): string {
  const name = k.name ?? KEY_NAMES[k.key] ?? (k.key.length === 1 ? k.key.toUpperCase() : k.key);
  // macOS writes ⌃⇧⌘K; elsewhere it is Ctrl+Shift+K.
  const parts = mac
    ? [k.ctrl ? "⌃" : "", k.alt ? "⌥" : "", k.shift ? "⇧" : "", k.mod ? "⌘" : "", name]
    : [k.mod || k.ctrl ? "Ctrl" : "", k.alt ? "Alt" : "", k.shift ? "Shift" : "", name];
  return parts.filter(Boolean).join(mac ? "" : "+");
}

/** Every way to press `b`, for the help overlay (none: off with this setting). */
export function formatBinding(b: Binding, mac: boolean, k9s = false): string[] {
  if (b.display) {
    return b.display.map((d) => d.replace("Mod+", mac ? "⌘" : "Ctrl+").replace("Shift+", mac ? "⇧" : "Shift+"));
  }
  // `?` is typed with Shift anyway; lower-case letters read better as typed.
  // In KEYMAP's order on every platform: ⌃` before ⌘J, as in VS Code (#592).
  return b.keys
    .filter((k) => keyLive(k, mac, k9s))
    .map((k) =>
      !k.mod && !k.ctrl && !k.shift && k.key.length === 1 && k.key !== " " ? k.key : formatKey(k, mac),
    );
}

/** "Ctrl+` or Ctrl+J": a command's keys for a tooltip. */
export function shortcutHint(command: Command, mac: boolean, k9s = false): string {
  const b = KEYMAP.find((x) => x.command === command);
  return b ? formatBinding(b, mac, k9s).join(" or ") : "";
}

/**
 * Whether `e` is Tab or Shift+Tab (#598). WebKitGTK may name Shift+Tab by
 * its keysym (ISO_Left_Tab), which arrives as `key: "Unidentified"` with
 * `code: "Tab"`: the physical key decides.
 */
export function isTab(e: Pick<KeyboardEvent, "key" | "code">): boolean {
  return e.key === "Tab" || e.code === "Tab";
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
