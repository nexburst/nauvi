import { describe, expect, it } from "vitest";
import { bindingFor, formatBinding, KEYMAP, leftToTerminal, shortcutHint } from "./keys";
import type { KeyEventLike } from "./keys";

const press = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const command = (e: KeyEventLike, mac = false) => bindingFor(e, mac)?.binding.command ?? null;

describe("bindingFor", () => {
  it("uses Ctrl elsewhere and Cmd on macOS", () => {
    expect(command(press("k", { ctrlKey: true }))).toBe("palette");
    expect(command(press("k", { metaKey: true }))).toBeNull();
    expect(command(press("k", { metaKey: true }), true)).toBe("palette");
    expect(command(press("k", { ctrlKey: true }), true)).toBeNull();
    expect(command(press("P", { ctrlKey: true }))).toBe("palette");
  });

  it("tells plain letters from their modified forms", () => {
    expect(command(press("k"))).toBe("rowUp");
    expect(command(press("j"))).toBe("rowDown");
    expect(command(press("J", { shiftKey: true }))).toBeNull();
    expect(command(press("j", { altKey: true }))).toBeNull();
  });

  it("matches punctuation typed with Shift", () => {
    expect(command(press("?", { shiftKey: true }))).toBe("help");
    expect(command(press("/"))).toBe("focusFilter");
  });

  it("needs Shift for Shift+F10 and accepts the Menu key", () => {
    expect(command(press("F10", { shiftKey: true }))).toBe("rowMenu");
    expect(command(press("F10"))).toBeNull();
    expect(command(press("ContextMenu"))).toBe("rowMenu");
  });

  it("gives the tab index for Ctrl+1…9", () => {
    const hit = bindingFor(press("3", { ctrlKey: true }), false);
    expect(hit?.binding.command).toBe("detailTab");
    expect(hit?.index).toBe(2);
    expect(command(press("3"))).toBeNull();
  });

  it("zooms with Mod+= (or Mod++), Mod+- and Mod+0 (#207)", () => {
    expect(command(press("=", { ctrlKey: true }))).toBe("zoomIn");
    expect(command(press("+", { ctrlKey: true, shiftKey: true }))).toBe("zoomIn");
    expect(command(press("=", { metaKey: true }), true)).toBe("zoomIn");
    expect(command(press("-", { ctrlKey: true }))).toBe("zoomOut");
    expect(command(press("0", { ctrlKey: true }))).toBe("zoomReset");
    expect(command(press("0", { metaKey: true }), true)).toBe("zoomReset");
    expect(command(press("-"))).toBeNull();
    expect(command(press("0"))).toBeNull();
    expect(shortcutHint("zoomIn", false)).toBe("Ctrl+=");
    expect(shortcutHint("zoomOut", true)).toBe("⌘-");
  });

  it("takes Cmd+Backspace as Delete on macOS only", () => {
    expect(command(press("Delete"))).toBe("deleteRows");
    expect(command(press("Backspace", { metaKey: true }), true)).toBe("deleteRows");
    expect(command(press("Backspace", { ctrlKey: true }))).toBeNull();
  });

  it("toggles the dock with Ctrl+` on every platform", () => {
    expect(command(press("`", { ctrlKey: true }))).toBe("toggleDock");
    expect(command(press("`", { ctrlKey: true }), true)).toBe("toggleDock");
    // Cmd+` switches windows on macOS.
    expect(command(press("`", { metaKey: true }), true)).toBeNull();
    expect(command(press("`"))).toBeNull();
  });

  it("opens a local terminal with Ctrl+Shift+` (the event's key is ~)", () => {
    expect(command(press("~", { ctrlKey: true, shiftKey: true }))).toBe("newLocalShell");
    expect(command(press("~", { ctrlKey: true, shiftKey: true }), true)).toBe("newLocalShell");
    expect(command(press("~", { shiftKey: true }))).toBeNull();
  });

  it("searches the terminal with Ctrl+Shift+F, ⌘F on macOS, and leaves Ctrl+F to the shell (#222)", () => {
    expect(command(press("F", { ctrlKey: true, shiftKey: true, code: "KeyF" }))).toBe("terminalSearch");
    expect(command(press("f", { ctrlKey: true, code: "KeyF" }))).toBeNull();
    expect(command(press("f", { metaKey: true, code: "KeyF" }), true)).toBe("terminalSearch");
    expect(command(press("f", { ctrlKey: true, code: "KeyF" }), true)).toBeNull();
    expect(command(press("F", { metaKey: true, shiftKey: true, code: "KeyF" }), true)).toBeNull();
    expect(command(press("F", { ctrlKey: true, shiftKey: true, altKey: true, code: "KeyF" }))).toBeNull();
    // Cyrillic: the F key types "а", so by the physical key.
    expect(command(press("А", { ctrlKey: true, shiftKey: true, code: "KeyF" }))).toBe("terminalSearch");
    expect(command(press("а", { metaKey: true, code: "KeyF" }), true)).toBe("terminalSearch");
    // Dvorak: the key at F types "u"; the F is elsewhere and is what counts.
    expect(command(press("U", { ctrlKey: true, shiftKey: true, code: "KeyF" }))).toBeNull();
    expect(command(press("F", { ctrlKey: true, shiftKey: true, code: "KeyY" }))).toBe("terminalSearch");
    expect(shortcutHint("terminalSearch", false)).toBe("Ctrl+Shift+F");
    expect(shortcutHint("terminalSearch", true)).toBe("⌘F");
  });

  it("takes the Backquote key where the backtick is a dead key", () => {
    // Spanish / Latin American / German: the key has no plain `.
    expect(command(press("Dead", { code: "Backquote", ctrlKey: true }))).toBe("toggleDock");
    expect(command(press("<", { code: "Backquote", ctrlKey: true }), true)).toBe("toggleDock");
    expect(command(press("Dead", { code: "Backquote", ctrlKey: true, shiftKey: true }))).toBe("newLocalShell");
    expect(command(press(">", { code: "Backquote", ctrlKey: true, shiftKey: true }), true)).toBe("newLocalShell");
    expect(command(press("Dead", { code: "Backquote" }))).toBeNull();
    expect(command(press("Dead", { code: "Backquote", ctrlKey: true, altKey: true }))).toBeNull();
    expect(command(press("Dead", { code: "Backquote", metaKey: true }), true)).toBeNull();
  });

  it("also takes Mod+J and Mod+Shift+J, which every layout can type", () => {
    expect(command(press("j", { ctrlKey: true }))).toBe("toggleDock");
    expect(command(press("j", { metaKey: true }), true)).toBe("toggleDock");
    expect(command(press("J", { ctrlKey: true, shiftKey: true }))).toBe("newLocalShell");
    expect(command(press("J", { metaKey: true, shiftKey: true }), true)).toBe("newLocalShell");
    expect(command(press("j", { ctrlKey: true }), true)).toBeNull();
  });

  it("leaves Ctrl+J to the shell inside a terminal, except ⌘J on macOS", () => {
    const hit = (e: KeyEventLike, mac: boolean) => {
      const h = bindingFor(e, mac)!;
      return leftToTerminal(h.binding, h.index, mac);
    };
    expect(hit(press("j", { ctrlKey: true }), false)).toBe(true);
    expect(hit(press("J", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(hit(press("j", { metaKey: true }), true)).toBe(false);
    expect(hit(press("`", { ctrlKey: true }), false)).toBe(false);
    expect(hit(press("Dead", { code: "Backquote", ctrlKey: true }), false)).toBe(false);
  });

  it("takes the engine's reload keys for Refresh (#205)", () => {
    expect(command(press("F5"))).toBe("refresh");
    expect(command(press("F5", { ctrlKey: true }))).toBe("refresh");
    expect(command(press("F5", { shiftKey: true }))).toBe("refresh");
    expect(command(press("r", { ctrlKey: true }))).toBe("refresh");
    expect(command(press("R", { ctrlKey: true, shiftKey: true }))).toBe("refresh");
    expect(command(press("r", { metaKey: true }), true)).toBe("refresh");
    expect(command(press("r"))).toBeNull();
    expect(command(press("r", { ctrlKey: true }), true)).toBeNull();
  });

  it("leaves F5 and Ctrl+R to the shell inside a terminal, but not ⌘R", () => {
    const left = (e: KeyEventLike, mac: boolean) => {
      const h = bindingFor(e, mac)!;
      return leftToTerminal(h.binding, h.index, mac);
    };
    expect(left(press("F5"), false)).toBe(true);
    expect(left(press("F5"), true)).toBe(true);
    expect(left(press("r", { ctrlKey: true }), false)).toBe(true);
    expect(left(press("R", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(left(press("r", { metaKey: true }), true)).toBe(false);
  });

  it("leaves Space with Shift alone", () => {
    expect(command(press(" "))).toBe("toggleRow");
    expect(command(press(" ", { shiftKey: true }))).toBeNull();
  });
});

describe("formatBinding", () => {
  const of = (c: string) => KEYMAP.find((b) => b.command === c)!;
  it("writes the keys the way the platform does", () => {
    expect(formatBinding(of("palette"), false)).toEqual(["Ctrl+K", "Ctrl+P"]);
    expect(formatBinding(of("palette"), true)).toEqual(["⌘K", "⌘P"]);
    expect(formatBinding(of("rowDown"), false)).toEqual(["↓", "j"]);
    expect(formatBinding(of("rowMenu"), false)).toEqual(["Shift+F10", "Menu"]);
    expect(formatBinding(of("detailTab"), false)).toEqual(["Ctrl+1…9"]);
    expect(formatBinding(of("deleteRows"), false)).toEqual(["Delete"]);
    expect(formatBinding(of("deleteRows"), true)).toEqual(["Delete", "⌘Backspace"]);
    expect(formatBinding(of("toggleRow"), false)).toEqual(["Space"]);
    expect(formatBinding(of("toggleDock"), false)).toEqual(["Ctrl+`", "Ctrl+J"]);
    expect(formatBinding(of("toggleDock"), true)).toEqual(["⌘J", "⌃`"]);
    expect(formatBinding(of("newLocalShell"), false)).toEqual(["Ctrl+Shift+`", "Ctrl+Shift+J"]);
    expect(formatBinding(of("newLocalShell"), true)).toEqual(["⇧⌘J", "⌃⇧`"]);
    expect(shortcutHint("toggleDock", true)).toBe("⌘J or ⌃`");
    expect(formatBinding(of("refresh"), false)).toEqual(["F5", "Ctrl+R"]);
    expect(shortcutHint("refresh", true)).toBe("F5 or ⌘R");
  });

  it("covers every binding with a label", () => {
    for (const b of KEYMAP) {
      expect(b.label).not.toBe("");
      expect(formatBinding(b, false).length).toBeGreaterThan(0);
    }
  });
});
