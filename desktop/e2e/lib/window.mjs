// Window size and the app's several windows (#45). WebDriver commands go
// to the current window; switch with `switchTo`.

import { By } from "selenium-webdriver";
import { byTestId } from "./app.mjs";

/**
 * Resize the current window (outer size, in CSS pixels) and wait until the
 * page sees the new size. Under Xvfb there is no window manager, so the
 * size is exactly what was asked for.
 */
export async function resizeWindow(app, width, height) {
  const before = await viewportSize(app);
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
