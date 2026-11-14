// This window. Each window is connected to its own cluster (#45): the
// backend sends a window only the events of what it started, so listeners
// listen on this window (`events.x(thisWindow()).listen`), not globally.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** The window opened on start; the others are opened for a context. */
export const MAIN_WINDOW = "main";

let current: WebviewWindow | null = null;

export function thisWindow(): WebviewWindow {
  current ??= getCurrentWebviewWindow();
  return current;
}

/**
 * Whether this is the main window. It starts in the remembered context and
 * remembers the one it switches to; the others start in the context they
 * were opened for.
 */
export function isMainWindow(): boolean {
  return thisWindow().label === MAIN_WINDOW;
}
