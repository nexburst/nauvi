// Reading what the app copied. Under qa.sh the app runs on its own Xvfb
// display, so its clipboard is separate from the desktop's; xclip / xsel read
// it there. Without either (or on Wayland, wl-paste), the page hook below
// records what the page passed to `navigator.clipboard.writeText`.

import { execFileSync } from "node:child_process";

const READERS = [
  ["xclip", ["-selection", "clipboard", "-o"]],
  ["xsel", ["--clipboard", "--output"]],
  ["wl-paste", ["--no-newline"]],
];

/**
 * The system clipboard's text, or null if no reader works here. Only call
 * it while the app is running: X11 clipboards live in the owning app.
 */
export function readSystemClipboard() {
  for (const [cmd, args] of READERS) {
    if (cmd === "wl-paste" && !process.env.WAYLAND_DISPLAY) continue;
    if (cmd !== "wl-paste" && !process.env.DISPLAY) continue;
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      /* not installed, or nothing on the clipboard */
    }
  }
  return null;
}

/**
 * Wrap `navigator.clipboard.writeText` in the current window so every text
 * the page copies is also kept in `window.__qaClipboard`. The real write
 * still happens (and its failure still reaches the app). Install it again
 * after a reload or in another window.
 */
export async function hookClipboard(app) {
  await app.js(`
    if (window.__qaClipboard) return;
    window.__qaClipboard = [];
    const clip = navigator.clipboard;
    if (!clip) return;
    const write = clip.writeText.bind(clip);
    clip.writeText = (text) => {
      window.__qaClipboard.push(String(text));
      return write(text);
    };`);
}

/** Texts recorded by `hookClipboard`, oldest first. */
export async function hookedClipboard(app) {
  return (await app.js("return window.__qaClipboard ?? []")) ?? [];
}

/**
 * Wait until the clipboard holds `expected`: the system clipboard if it can
 * be read, otherwise the hook. Returns `{ text, source }`.
 */
export async function waitForClipboard(app, expected, { timeout = 10_000 } = {}) {
  return app.waitFor(
    async () => {
      const sys = readSystemClipboard();
      if (sys !== null && sys.trim() === expected) return { text: sys.trim(), source: "system" };
      const hooked = await hookedClipboard(app);
      if (sys === null && hooked.at(-1) === expected) return { text: expected, source: "hook" };
      return null;
    },
    { timeout, message: `"${expected}" on the clipboard (system: ${JSON.stringify(readSystemClipboard())})` },
  );
}
