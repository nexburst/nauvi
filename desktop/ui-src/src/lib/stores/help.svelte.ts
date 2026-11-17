// The Help menu and About (#208): the diagnostics, "Copy diagnostics" and
// the menu's items (the backend opens the URLs and the log folder).

import { commands } from "../bindings";
import type { Diagnostics, HelpItem } from "../bindings";
import { setNotice } from "./actions.svelte";
import { openSettings } from "./keyboard.svelte";

export const help = $state({
  /** The header's Help menu is open. */
  menuOpen: false,
  diagnostics: null as Diagnostics | null,
  error: "",
  /** Settings was opened from Help → About: scroll to the About section. */
  showAbout: false,
});

export async function loadDiagnostics(): Promise<Diagnostics | null> {
  if (help.diagnostics) return help.diagnostics;
  try {
    help.diagnostics = await commands.cmdDiagnostics();
    help.error = "";
  } catch (e) {
    help.error = `Could not read the version: ${e}`;
  }
  return help.diagnostics;
}

/** Copy the version, commit, OS and webview (no paths, contexts or
 *  settings). Returns what to show next to the button. */
export async function copyDiagnostics(): Promise<{ ok: boolean; text: string }> {
  const d = await loadDiagnostics();
  if (!d) return { ok: false, text: help.error };
  try {
    await navigator.clipboard.writeText(d.text);
    return { ok: true, text: "Copied." };
  } catch {
    return { ok: false, text: "Could not copy to the clipboard; select the text above instead." };
  }
}

export async function openHelpItem(item: HelpItem) {
  help.menuOpen = false;
  try {
    await commands.cmdHelpOpen(item);
  } catch (e) {
    setNotice(false, String(e));
  }
}

/** Help → About nauvi: Settings, at its About section. */
export function openAbout() {
  help.menuOpen = false;
  help.showAbout = true;
  openSettings();
}
