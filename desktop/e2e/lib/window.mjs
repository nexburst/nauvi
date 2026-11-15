// Window size and the app's several windows (#45). WebDriver commands go
// to the current window; switch with `switchTo`.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { By } from "selenium-webdriver";
import { byTestId } from "./app.mjs";

/**
 * Resize the current window (outer size, in CSS pixels) and wait until the
 * page sees the new size. Under Xvfb there is no window manager, so the
 * size is exactly what was asked for.
 */
export async function resizeWindow(app, width, height) {
  const before = await viewportSize(app);
  const rect = await app.driver.manage().window().getRect();
  // Already that size (the app opens at 1280x800): nothing would change.
  if (rect.width === width && rect.height === height) return before;
  await app.driver.manage().window().setRect({ width, height });
  await app.waitFor(
    async () => {
      const now = await viewportSize(app);
      return now.width !== before.width || now.height !== before.height ? now : null;
    },
    { timeout: 10_000, message: `the window to resize to ${width}x${height}` },
  );
  return viewportSize(app);
}

/** The page's `innerWidth` / `innerHeight`. */
export function viewportSize(app) {
  return app.js("return { width: window.innerWidth, height: window.innerHeight }");
}

/** WebDriver handles of every open window. */
export function windowHandles(app) {
  return app.driver.getAllWindowHandles();
}

export function switchTo(app, handle) {
  return app.driver.switchTo().window(handle);
}

/** Title of each window, by handle. Leaves the current window selected. */
export async function windowTitles(app) {
  const current = await app.driver.getWindowHandle();
  const titles = {};
  for (const h of await windowHandles(app)) {
    await switchTo(app, h);
    titles[h] = await app.driver.getTitle();
  }
  await switchTo(app, current);
  return titles;
}

/**
 * Click "Open in new window" in the current window and return the new
 * window's handle (not switched to).
 */
export async function openNewWindow(app) {
  const before = await windowHandles(app);
  await (await app.find(byTestId("open-in-new-window"))).click();
  const all = await app.waitFor(
    async () => {
      const now = await windowHandles(app);
      return now.length > before.length ? now : null;
    },
    { message: "a new window" },
  );
  return all.find((h) => !before.includes(h));
}

/** Pick a context in the header's context select of the current window. */
export async function selectContext(app, context) {
  const select = await app.find(By.css('select[aria-label="Cluster context"]'));
  await app.js(
    `const s = arguments[0];
     s.value = arguments[1];
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
    select,
    context,
  );
  await app.waitFor(async () => (await select.getAttribute("value")) === context, {
    message: `context select on ${context}`,
  });
}

/**
 * X11 windows of process `pid` that take WM_DELETE_WINDOW and are shown
 * (Linux, $DISPLAY; uses xwininfo and xprop). Returns hex ids.
 */
export function x11Windows(pid) {
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const ids = [...run("xwininfo", ["-root", "-children"]).matchAll(/^\s+(0x[0-9a-f]+)/gim)].map((m) => m[1]);
  return ids.filter((id) => {
    try {
      const props = run("xprop", ["-id", id, "_NET_WM_PID", "WM_PROTOCOLS"]);
      if (!new RegExp(`_NET_WM_PID\\(CARDINAL\\) = ${pid}\\b`).test(props) || !props.includes("WM_DELETE_WINDOW")) return false;
      return /Map State: IsViewable/.test(run("xwininfo", ["-id", id]));
    } catch {
      return false;
    }
  });
}

/**
 * The native titles of the app's windows (`_NET_WM_NAME`), sorted. WebDriver's
 * getTitle() returns the page's <title>, not the window's.
 */
export function x11Titles(pid) {
  return x11Windows(pid).map(x11Title).sort();
}

function x11Title(id) {
  const out = execFileSync("xprop", ["-id", id, "_NET_WM_NAME"], { encoding: "utf8" });
  return out.match(/= "(.*)"/)?.[1] ?? "";
}

/** Why `closeLikeUser` cannot work here (a string), or false when it can. */
export function cannotCloseLikeUser() {
  if (process.platform !== "linux") return "closing like a user needs X11 (Linux)";
  if (!process.env.DISPLAY) return "no $DISPLAY";
  for (const tool of ["xwininfo", "xprop", "python3"]) {
    try {
      execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    } catch {
      return `no ${tool} (x11-utils / python3) to close the window like a user`;
    }
  }
  return false;
}

/**
 * Press X11 keys (keysym names, e.g. "Menu") in the app's window through
 * XTEST (lib/xkey.py), for keys WebDriver cannot send. Focuses the first
 * window of `pid`; returns false when there is none.
 */
export function pressX11Keys(pid, ...keysyms) {
  const [id] = x11Windows(pid);
  if (!id) return false;
  execFileSync("python3", [join(dirname(fileURLToPath(import.meta.url)), "xkey.py"), id, ...keysyms], { stdio: "inherit" });
  return true;
}

/**
 * Close the app's windows the way a window manager's close button does
 * (WM_DELETE_WINDOW, lib/wm-close.py), so the app's own close and exit
 * handlers run. WebDriver's Close Window on the last window ends the session
 * and kills the app instead (and on another window it drops the webview but
 * leaves the native window open). `title`: only the windows with that
 * native title. Returns the window ids; throws when the app has no window
 * to close (or the X tools are missing).
 */
export function closeLikeUser(pid, { title } = {}) {
  const ids = x11Windows(pid).filter((id) => title === undefined || x11Title(id) === title);
  if (ids.length === 0) throw new Error(`no X11 window of pid ${pid} on ${process.env.DISPLAY}`);
  execFileSync("python3", [join(dirname(fileURLToPath(import.meta.url)), "wm-close.py"), ...ids], { stdio: "inherit" });
  return ids;
}
