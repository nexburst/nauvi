// Preferences (#330), in the real app (WebKitGTK) against kind:
// - Start at login: off by default (no XDG autostart entry in the app's
//   own HOME); ticking it writes ~/.config/autostart/<app>.desktop that
//   runs this binary, unticking removes it; when the entry cannot be
//   written (~/.config/autostart is a file) the error is shown and the box
//   stays off
// - the YAML editor's font size reaches an open editor
// - compact table rows: Pods rows are 22 px instead of 28
// - UTC: the footer's "Updated" clock says UTC
// - all of it kept in settings.json and after a restart
// Light and dark theme at 1280x800. Reads the cluster only.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  return app.find(byTestId("settings"));
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, {
    message: "Settings closed",
  });
}

/** Scroll the Settings page to the section with `testid`. */
const showSection = (app, testid) =>
  app.js(`document.querySelector('[data-testid="${testid}"]').scrollIntoView({ block: "start" })`);

const autostartBox = (app) => app.find(By.css('[data-testid="settings"] input[aria-label="Start at login"]'));

const rowHeight = (app) =>
  app.js(`return document.querySelector('[data-testid="resource-row"]')?.getBoundingClientRect().height ?? 0`);

describe("preferences", { timeout: 15 * 60_000 }, () => {
  const s = appSession("preferences");
  const autostartDir = () => join(s.app.profile.home, ".config", "autostart");
  const entries = () => (existsSync(autostartDir()) ? readdirSync(autostartDir()).filter((f) => f.endsWith(".desktop")) : []);

  it("start at login is off by default (dark)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await waitLive(app);
    await openSettings(app);
    const box = await autostartBox(app);
    await app.waitFor(async () => await box.isEnabled(), { message: "the start-at-login state read from the OS" });
    assert.equal(await box.isSelected(), false);
    assert.deepEqual(entries(), []);
    await showSection(app, "editor-settings");
  });

  it("a start-at-login entry that cannot be written shows the error (dark)", T, async () => {
    const { app } = s;
    // A file where the autostart folder goes: the entry cannot be written.
    mkdirSync(join(app.profile.home, ".config"), { recursive: true });
    writeFileSync(autostartDir(), "not a folder");
    try {
      await showSection(app, "startup-settings");
      await (await autostartBox(app)).click();
      const error = await app.find(byTestId("autostart-error"));
      await app.waitFor(async () => /Could not turn on start at login/.test(await error.getText()), {
        message: "the error",
      });
      assert.equal(await (await autostartBox(app)).isSelected(), false);
    } finally {
      rmSync(autostartDir(), { force: true });
    }
  });

  it("ticking it writes the XDG autostart entry for this binary (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await showSection(app, "startup-settings");
    await (await autostartBox(app)).click();
    await app.waitFor(async () => entries().length === 1, { message: "an autostart .desktop entry" });
    const text = readFileSync(join(autostartDir(), entries()[0]), "utf8");
    console.log(`autostart entry:\n${text}`);
    assert.match(text, /^Exec=\S*nauvi-desktop/m);
    assert.equal(await (await autostartBox(app)).isSelected(), true);
    assert.equal((await app.driver.findElements(byTestId("autostart-error"))).length, 0);
  });

  it("unticking it removes the entry; set editor font, compact rows and UTC (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await (await autostartBox(app)).click();
    await app.waitFor(async () => entries().length === 0, { message: "the autostart entry to go" });
    const font = await app.find(By.css('[data-testid="settings"] input[aria-label="Editor font size"]'));
    await app.setValue(font, "16");
    await app.js(`document.querySelector('[data-testid="settings"] input[name="row-height"][value="compact"]').click()`);
    await app.js(`document.querySelector('[data-testid="settings"] input[name="time-zone"][value="utc"]').click()`);
    await app.waitFor(
      () => {
        const st = app.profile.settings();
        return st?.editor_font_size === 16 && st?.row_height === "compact" && st?.time_zone === "utc";
      },
      { message: "the preferences in settings.json" },
    );
    await showSection(app, "time-settings");
  });

  it("compact rows in Pods and UTC in the footer (dark)", T, async () => {
    const { app } = s;
    await closeSettings(app);
    await app.nav("Pods");
    await app.waitFor(async () => Math.round(await rowHeight(app)) === 22, { message: "22 px rows" });
    await app.nav("Overview");
    await app.waitFor(
      async () => / UTC$/.test(await app.js(`return document.querySelector("footer")?.innerText.trim() ?? ""`)),
      { timeout: 60_000, message: "Updated … UTC in the footer" },
    );
    await app.nav("Pods");
  });

  it("the YAML editor uses the font size (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.openDetail("Deployments", "demo", "web");
    await (await app.find(By.xpath("//aside//*[@role='tab'][normalize-space()='YAML']"))).click();
    await app.find(By.css('aside .code-editor[data-ready="true"]'));
    const size = await app.js(`return getComputedStyle(document.querySelector("aside .cm-editor")).fontSize`);
    assert.equal(size, "16px");
  });

  it("kept after a restart (light)", T, async () => {
    const { app } = s;
    await app.restart();
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Pods");
    await app.waitFor(async () => Math.round(await rowHeight(app)) === 22, { message: "22 px rows after a restart" });
    await openSettings(app);
    assert.equal(await (await autostartBox(app)).isSelected(), false);
    const font = await app.find(By.css('[data-testid="settings"] input[aria-label="Editor font size"]'));
    assert.equal(await font.getAttribute("value"), "16");
    await showSection(app, "layout-settings");
  });
});
