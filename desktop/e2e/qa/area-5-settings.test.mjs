// QA area 5 (#83): the Settings page and themes (PR #70), its Helm
// repositories and Updates sections (#94, #85) as seen in WebKitGTK.
// Checks: Ctrl+, opens Settings; the page at 1280x800 in Dark and Light
// (screenshots), with the native <select>, radio and checkbox controls; the
// Light theme over the Pods table, the detail panel and the Columns chooser;
// log defaults (tail, timestamps, wrap) reach a new log tab; System follows
// the desktop's light or dark preference (GTK_THEME).
// Persistence across restarts is in persistence.test.mjs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { openPodLogs, pane } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };

/** Relative luminance (0..1) of the body's background colour. */
const bodyLuminance = (app) =>
  app.js(`
    const m = getComputedStyle(document.body).backgroundColor.match(/\\d+(\\.\\d+)?/g).map(Number);
    return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
  `);

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  return app.find(byTestId("settings"));
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, { message: "Settings closed" });
}

async function setTheme(app, theme) {
  await app.js(`document.querySelector('[data-testid="settings"] input[name="theme"][value="${theme}"]').click()`);
}

/** Native controls on the Settings page: their computed colours, for the log. */
const controlStyles = (app) =>
  app.js(`
    const s = (el) => el && { color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor, scheme: getComputedStyle(el).colorScheme };
    const root = document.querySelector('[data-testid="settings"]');
    return {
      select: s(root.querySelector("select")),
      checkbox: s(root.querySelector('input[type="checkbox"]')),
      dialog: s(root),
    };
  `);

describe("area 5: Settings page and themes", { timeout: 10 * 60_000 }, () => {
  const s = appSession("area-5-settings");

  it("Ctrl+, opens Settings (dark, 1280x800)", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await openSettings(app);
    const text = await app.js(`return document.querySelector('[data-testid="settings"]').innerText`);
    for (const section of ["Theme", "Log defaults", "Prometheus", "Helm repositories", "Updates", "Layout"]) {
      assert.ok(text.toLowerCase().includes(section.toLowerCase()), `Settings has ${section}`);
    }
    assert.ok((await bodyLuminance(app)) < 0.2, "dark by default");
    console.log(`dark controls: ${JSON.stringify(await controlStyles(app))}`);
  });

  it("Settings in the Light theme", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.waitFor(async () => (await app.js("return document.documentElement.dataset.theme")) === "light", {
      message: "data-theme=light",
    });
    assert.ok((await bodyLuminance(app)) > 0.8, "light background");
    const styles = await controlStyles(app);
    console.log(`light controls: ${JSON.stringify(styles)}`);
    assert.equal(styles.select.scheme, "light", "the select uses the light colour scheme");
    // The page scrolls inside: look at the bottom too.
    await app.js(`document.querySelector('[data-testid="update-settings"]').scrollIntoView()`);
    await app.shot("settings-light-bottom");
  });

  it("Pods, the detail panel and the Columns chooser in Light", T, async () => {
    const { app } = s;
    await closeSettings(app);
    await app.nav("Pods");
    await app.filter("web-");
    const web = await app.waitFor(async () => (await app.rows()).find(([n, ns]) => ns === "demo" && n.startsWith("web-"))?.[0], {
      message: "a demo/web pod",
    });
    await (await app.find(app.row(web, "demo"))).click();
    await app.find(byTestId("detail-panel"));
    // A checkbox ticked: select the row.
    await app.js(`document.querySelector('[data-testid="resource-row"] input[type="checkbox"]')?.click()`);
    await (await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"))).click();
    await app.find(By.css('[role="dialog"][aria-label="Columns"]'));
    await app.shot("pods-light-columns");
    await (await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"))).click();
    await app.js(`document.querySelector('[data-testid="resource-row"] input[type="checkbox"]')?.click()`);
  });

  it("log defaults reach a new log tab", T, async () => {
    const { app } = s;
    await openSettings(app);
    const tail = await app.find(By.css('[data-testid="settings"] select[aria-label="Default tail lines"]'));
    await app.js(
      `arguments[0].value = "1000"; arguments[0].dispatchEvent(new Event("change", { bubbles: true }));`,
      tail,
    );
    await app.js(`
      for (const l of document.querySelectorAll('[data-testid="settings"] label.choice')) {
        const t = l.textContent.trim();
        const i = l.querySelector('input[type="checkbox"]');
        if ((t === "Show timestamps" || t === "Wrap long lines") && !i.checked) i.click();
      }`);
    await app.waitFor(async () => {
      const logs = app.profile.settings()?.logs;
      return logs?.tail === "1000" && logs.timestamps && logs.wrap;
    }, { message: "log defaults saved" });
    await closeSettings(app);
    const id = await openPodLogs(app, "demo", (await app.rows()).find(([n]) => n.startsWith("web-"))[0]);
    const opts = await app.js(
      `const p = document.querySelector(arguments[0]);
       const boxes = Array.from(p.querySelectorAll("label.check"), (l) => [l.textContent.trim(), l.querySelector("input").checked]);
       return { tail: p.querySelector('select[title="Tail lines"]').value, boxes };`,
      pane(id),
    );
    console.log(`log tab options: ${JSON.stringify(opts)}`);
    assert.equal(opts.tail, "1000");
    const boxes = Object.fromEntries(opts.boxes);
    assert.equal(boxes.Timestamps, true);
    assert.equal(boxes.Wrap, true);
  });

  it("back to Dark", T, async () => {
    const { app } = s;
    await openSettings(app);
    await setTheme(app, "dark");
    await app.waitFor(async () => (await bodyLuminance(app)) < 0.2, { message: "dark background" });
  });
});

// GTK_THEME decides WebKitGTK's prefers-color-scheme under Xvfb (no desktop).
for (const [gtk, dark] of [
  ["Adwaita", false],
  ["Adwaita:dark", true],
]) {
  describe(`area 5: System theme with GTK_THEME=${gtk}`, { timeout: 5 * 60_000 }, () => {
    // The session bus is cut off, so the developer's own desktop setting
    // (xdg-desktop-portal's color-scheme) doesn't decide it instead.
    const s = appSession(`area-5-settings-system-${dark ? "dark" : "light"}`, {
      env: { GTK_THEME: gtk, DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/qa-area5-bus" },
    });

    it(`System follows the desktop (${dark ? "dark" : "light"})`, T, async () => {
      const { app } = s;
      await waitLive(app);
      assert.equal(app.profile.settings()?.theme ?? "system", "system");
      const prefers = await app.js("return matchMedia('(prefers-color-scheme: dark)').matches");
      const lum = await bodyLuminance(app);
      console.log(`GTK_THEME=${gtk}: prefers dark ${prefers}, body luminance ${lum.toFixed(2)}`);
      assert.equal(prefers, dark);
      assert.equal(lum < 0.5, dark);
      await openSettings(app);
    });
  });
}
