// The webview engine's own context menu (Back, Reload, and in WebView2
// Save as and Print) means nothing in the app, and its Reload drops the
// window's work (#205). It stays only where typing goes, the YAML editor
// and the terminal included, for its Copy and Paste. The app's own menus
// (a table row's) open from their own handlers first.

import { isTextEntry } from "./keys";

/** Whether a right click on `target` keeps the engine's menu. */
export function keepsEngineMenu(target: EventTarget | null): boolean {
  return target instanceof Element && isTextEntry(target);
}

/** Suppress the engine's menu everywhere else in `root`'s window. */
export function suppressEngineMenu(root: Window): void {
  root.addEventListener("contextmenu", (e) => {
    if (!keepsEngineMenu(e.target)) e.preventDefault();
  });
}
