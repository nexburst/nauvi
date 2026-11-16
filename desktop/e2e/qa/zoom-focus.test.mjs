// Zoom, the terminal font size and keyboard focus (#207) in WebKitGTK.
// Checks: Ctrl+= / Ctrl+- / Ctrl+0 zoom the real webview (the page's CSS
// width shrinks by the zoom), from the table and from a terminal; the
// zoomed layout at 1280x800 in Dark and Light (table, detail panel, dock,
// Settings) has no horizontal page scroll; the zoom is saved and set again
// after a restart; clicking a row moves the keyboard focus from the filter
// to the table; picking Shell in the row menu with Enter opens a shell that
// did not get that Enter (one prompt, no empty command); the terminal font
// size from Settings applies to an open terminal at once (bigger cells,
// fewer columns).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { terminal } from "../lib/terminal.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ns;

const press = (app, ...keys) => app.driver.actions().sendKeys(...keys).perform();
const ctrl = (app, key) => app.driver.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
const count = (app, css) => app.js(`return document.querySelectorAll(arguments[0]).length`, css);

/** The page's CSS width and whether anything makes the page scroll sideways. */
const layout = (app) =>
  app.js(`return {
    width: window.innerWidth,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }`);

async function waitZoom(app, percent) {
  // The window is 1280 px wide (Xvfb has no decorations): at 125% the page
  // is 1024 CSS px wide.
  const want = Math.round(1280 / (percent / 100));
  await app.waitFor(async () => Math.abs((await layout(app)).width - want) <= 2, {
    message: `the page ${want}px wide at ${percent}%`,
  });
  await app.waitFor(async () => (app.profile.settings()?.zoom ?? 100) === percent, { message: `zoom ${percent} saved` });
}

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await ctrl(app, ",");
  return app.find(byTestId("settings"));
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await count(app, '[data-testid="settings"]')) === 0, { message: "Settings closed" });
}

async function setTheme(app, theme) {
  await openSettings(app);
  await app.js(`document.querySelector('[data-testid="settings"] input[name="theme"][value="${theme}"]').click()`);
  await app.waitFor(async () => (await app.js("return document.documentElement.dataset.theme")) === theme, {
    message: `data-theme=${theme}`,
  });
}

/** The pod `shell` in the temp namespace, listed alone. */
async function showShellPod(app) {
  await app.nav("Pods");
  await pickNamespaces(app, [ns]);
  await app.waitFor(async () => (await app.rows()).some(([n]) => n === "shell"), { message: "the shell pod listed" });
}

describe("zoom, terminal font size and focus", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-zoom", httpPodYaml("shell"));
    waitPodReady(ns, "shell");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("zoom-focus");

  it("Ctrl+= zooms the window to 125% (dark, 1280x800)", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await closeSettings(app);
    await waitZoom(app, 100);
    await showShellPod(app);
    await (await app.find(app.row("shell", ns))).click();
    await app.find(byTestId("detail-panel"));
    await app.js("document.activeElement?.blur()");
    await ctrl(app, "=");
    await waitZoom(app, 110);
    await ctrl(app, "=");
    await waitZoom(app, 125);
    const l = await layout(app);
    console.log(`at 125%: ${JSON.stringify(l)}`);
    assert.ok(l.overflow <= 0, `no sideways page scroll at 125% (${l.overflow}px)`);
  });

  it("the zoomed layout in Light, with Settings open", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    const text = await app.js(`return document.querySelector('[data-testid="zoom-settings"]').innerText`);
    console.log(`zoom settings: ${JSON.stringify(text)}`);
    assert.ok(text.includes("125%"), "Settings shows the zoom");
    await app.shot("settings-zoomed-light");
    await closeSettings(app);
    assert.ok((await layout(app)).overflow <= 0, "no sideways page scroll");
  });

  it("clicking a row gives the table the keyboard", T, async () => {
    const { app } = s;
    await app.js("document.activeElement?.blur()");
    await press(app, "/");
    assert.equal(await app.js(`return document.activeElement?.getAttribute("aria-label")`), "Filter");
    await (await app.find(app.row("shell", ns))).click();
    await app.waitFor(async () => (await app.js(`return document.activeElement?.getAttribute("role")`)) === "grid", {
      message: "the grid focused after the click",
    });
    // So Shift+F10 is the row's menu, not a key in the filter.
    assert.equal(await app.js(`return document.querySelector("#table-filter")?.value`), "");
  });

  it("Enter on Shell in the row menu opens a shell that did not get the Enter", T, async () => {
    const { app } = s;
    await app.driver.actions().keyDown(Key.SHIFT).sendKeys(Key.F10).keyUp(Key.SHIFT).perform();
    await app.find(byTestId("context-menu"));
    const focused = () =>
      app.js(`return document.activeElement?.getAttribute("role") === "menuitem" ? document.activeElement.textContent.trim() : null`);
    for (let i = 0; i < 8 && (await app.waitFor(focused, { message: "a focused menu item" })) !== "Shell"; i++) {
      await press(app, Key.ARROW_DOWN);
    }
    assert.equal(await focused(), "Shell");
    await press(app, Key.ENTER);
    const term = terminal(app);
    await term.waitForPrompt();
    // A stray Enter would run an empty command: a second prompt line.
    await sleep(1500);
    const screen = await term.screen();
    const prompts = screen.split("\n").filter((l) => /[$#%>]\s*$/.test(l));
    console.log(`screen after Shell:\n${screen}`);
    assert.equal(prompts.length, 1, `one prompt, no empty command: ${JSON.stringify(screen)}`);
    assert.equal(await term.run("hostname"), "shell");
    assert.ok((await layout(app)).overflow <= 0, "no sideways page scroll with the dock open");
  });

  it("Ctrl+- and Ctrl+0 work from inside the terminal", T, async () => {
    const { app } = s;
    assert.ok(await app.js(`return !!document.activeElement?.closest(".xterm")`), "the terminal has the focus");
    await ctrl(app, "-");
    await waitZoom(app, 110);
    await ctrl(app, "0");
    await waitZoom(app, 100);
    // The shell got none of them (Ctrl+- would be ^_).
    assert.equal(await terminal(app).run("echo ok"), "ok");
  });

  it("the terminal font size applies to the open terminal", T, async () => {
    const { app } = s;
    const term = terminal(app);
    const [, before] = await term.size();
    await openSettings(app);
    const input = await app.find(By.css('[data-testid="settings"] input[aria-label="Terminal font size"]'));
    await app.js(
      `arguments[0].value = "18"; arguments[0].dispatchEvent(new Event("change", { bubbles: true }));`,
      input,
    );
    await app.waitFor(async () => app.profile.settings()?.terminal_font_size === 18, { message: "font size saved" });
    await closeSettings(app);
    await app.waitFor(
      async () => (await app.js(`return getComputedStyle(document.querySelector(".xterm-rows")).fontSize`)) === "18px",
      { message: "the terminal at 18px" },
    );
    await sleep(500);
    const [, now] = await term.size();
    console.log(`columns at 12px ${before}, at 18px ${now}`);
    assert.ok(now < before, `fewer columns at 18px (${before} -> ${now})`);
    await term.type("clear");
    await term.type("echo font-18");
    await term.waitFor("font-18");
    await app.shot("terminal-18px-light");
  });

  it("the zoom comes back after a restart (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await closeSettings(app);
    await app.js("document.activeElement?.blur()");
    await ctrl(app, "=");
    await ctrl(app, "=");
    await ctrl(app, "=");
    await waitZoom(app, 125);
    await app.restart();
    await waitLive(app);
    console.log(`window after the restart: ${JSON.stringify(await app.driver.manage().window().getRect())}`);
    await waitZoom(app, 125);
    await showShellPod(app);
    await (await app.find(app.row("shell", ns))).click();
    await app.find(byTestId("detail-panel"));
    assert.ok((await layout(app)).overflow <= 0, "no sideways page scroll after the restart");
    await app.shot("zoomed-125-dark-after-restart");
    // Back to 100% for whoever looks at this profile next.
    await ctrl(app, "0");
    await waitZoom(app, 100);
  });
});
