// Shift+Tab in WebKitGTK (#598), against kind, at 1280x800 in the dark and
// the light theme. WebKitGTK may name Shift+Tab `key: "Unidentified"`,
// `code: "Tab"`, which the confirm dialogs and the context menu missed. One
// pod in a temp namespace:
// - Ctrl+D on it opens "Delete Pod": Tab and Shift+Tab go round Cancel and
//   Delete, and the focus never goes outside the dialog (a focusin
//   listener counts every focus outside it); Escape cancels
// - on a protected cluster the type-the-name prompt keeps the focus the
//   same way
// - Shift+Tab closes the row's context menu
// The pod is never deleted.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { actionDialogText, contextMenu, openKind, waitActionDialogClosed } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const POD = "qa-shift-tab";
let ns = "";

const podYaml = `apiVersion: v1
kind: Pod
metadata: { name: ${POD} }
spec:
  terminationGracePeriodSeconds: 0
  containers: [{ name: main, image: "busybox:1.36", imagePullPolicy: IfNotPresent, command: ["sh", "-c", "sleep 3600"] }]
`;

const press = (app, ...keys) => app.driver.actions().sendKeys(...keys).perform();
const ctrl = (app, key) => app.driver.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
const shiftTab = (app) => app.driver.actions().keyDown(Key.SHIFT).sendKeys(Key.TAB).keyUp(Key.SHIFT).perform();
const count = (app, css) => app.js(`return document.querySelectorAll(arguments[0]).length`, css);
/** What has the keyboard focus: its test id, or its tag and text. */
const focused = (app) =>
  app.js(`const a = document.activeElement;
    return a?.getAttribute("data-testid") || (a ? a.tagName.toLowerCase() + ":" + (a.textContent ?? "").trim() : "");`);
const podExists = () => {
  try {
    return kubectl(["-n", ns, "get", "pod", POD, "-o", "jsonpath={.metadata.deletionTimestamp}"]).trim() === "";
  } catch {
    return false;
  }
};

/** From now on, count every focus outside `css` and record the key events. */
const watchFocus = (app, css) =>
  app.js(
    `window.__qaKeys = []; window.__qaLeft = [];
     window.__qaOff?.();
     const keys = (e) => e.code === "Tab" && window.__qaKeys.push([e.key, e.code, e.shiftKey]);
     const focus = (e) => {
       if (!e.target.closest?.(arguments[0])) window.__qaLeft.push(e.target.tagName + ":" + (e.target.textContent ?? "").trim().slice(0, 30));
     };
     window.addEventListener("keydown", keys, true);
     document.addEventListener("focusin", focus, true);
     window.__qaOff = () => {
       window.removeEventListener("keydown", keys, true);
       document.removeEventListener("focusin", focus, true);
     };`,
    css,
  );
const watched = (app) => app.js("return { keys: window.__qaKeys, left: window.__qaLeft }");

async function bothThemes(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.js("return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

/** The Pods table of the temp namespace, with the keyboard on its first row. */
async function podsTable(app) {
  await openKind(app, "Pods", ns);
  await app.waitFor(async () => (await count(app, '[data-testid="resource-row"]')) > 0, { message: "pod rows" });
  await app.js(`document.querySelector('[role="grid"]').focus()`);
  await press(app, "j");
}

/** Pick a mode on this cluster's settings page, then close it. */
async function setMode(app, label) {
  await app.palette("cluster settings", "Cluster settings");
  const dialog = await app.find(byTestId("cluster-settings"));
  const radio = await dialog.findElement(
    By.xpath(`.//label[contains(@class,'mode-choice')][.//strong[normalize-space()=${xq(label)}]]/input`),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", radio);
  await radio.click();
  await app.waitFor(async () => radio.isSelected(), { message: `${label} selected` });
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await count(app, '[data-testid="cluster-settings"]')) === 0, {
    message: "the cluster settings to close",
  });
}

describe("Shift+Tab in WebKitGTK", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-shift-tab", podYaml);
    waitPodReady(ns, POD);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("shift-tab");

  it("a confirm dialog: Tab and Shift+Tab go round its buttons; the focus never leaves it", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await podsTable(app);
    await ctrl(app, "d");
    const text = await app.waitFor(() => actionDialogText(app), { message: "the delete dialog" });
    console.log(`dialog: ${text}`);
    await app.waitFor(async () => (await focused(app)) === "action-confirm", { message: "Delete focused" });
    await watchFocus(app, '[data-testid="action-dialog"]');

    // Cancel comes first in the dialog: from it, an untrapped Shift+Tab
    // leaves the dialog.
    await shiftTab(app);
    assert.equal(await focused(app), "button:Cancel", "Shift+Tab goes to Cancel");
    await bothThemes(app, "dialog-cancel");
    await shiftTab(app);
    assert.equal(await focused(app), "action-confirm", "Shift+Tab goes round to Delete");
    for (let i = 0; i < 6; i++) await shiftTab(app);
    for (let i = 0; i < 6; i++) await press(app, Key.TAB);
    const seen = await watched(app);
    console.log(`Tab events: ${JSON.stringify(seen.keys)}`);
    console.log(`focus outside the dialog: ${JSON.stringify(seen.left)}`);
    assert.deepEqual(seen.left, [], "the focus never went outside the dialog");
    assert.equal(await focused(app), "action-confirm", "an even number of Tabs ends on Delete");
    await bothThemes(app, "dialog-after-tabs");
    await press(app, Key.ESCAPE);
    await waitActionDialogClosed(app);
    assert.ok(podExists(), `${POD} is still there`);
  });

  it("a protected cluster's type-the-name prompt keeps the focus on Shift+Tab", T, async () => {
    const { app } = s;
    await setMode(app, "Protected");
    try {
      await podsTable(app);
      await ctrl(app, "d");
      await app.waitFor(async () => (await focused(app)) === "action-confirm", { message: "Delete focused" });
      await press(app, Key.ENTER);
      await app.waitFor(async () => (await focused(app)) === "protected-confirm-input", {
        message: "the context name field focused",
      });
      await watchFocus(app, '[data-testid="protected-confirm"]');
      await shiftTab(app);
      assert.equal(await focused(app), "button:Cancel", "Shift+Tab goes to the prompt's Cancel");
      await bothThemes(app, "protected-cancel");
      await shiftTab(app);
      assert.equal(await focused(app), "protected-confirm-input", "Shift+Tab goes round to the field");
      for (let i = 0; i < 5; i++) await shiftTab(app);
      for (let i = 0; i < 5; i++) await press(app, Key.TAB);
      const seen = await watched(app);
      console.log(`Tab events: ${JSON.stringify(seen.keys)}`);
      console.log(`focus outside the prompt: ${JSON.stringify(seen.left)}`);
      assert.deepEqual(seen.left, [], "the focus never went outside the prompt");
      await press(app, Key.ESCAPE);
      await app.waitFor(async () => (await count(app, '[data-testid="protected-confirm"]')) === 0, { message: "prompt closed" });
      await press(app, Key.ESCAPE);
      await waitActionDialogClosed(app);
      assert.ok(podExists(), `${POD} is still there`);
    } finally {
      await app.js("window.__qaOff?.()");
      await setMode(app, "Normal");
    }
  });

  it("Shift+Tab closes the row's context menu", T, async () => {
    const { app } = s;
    await podsTable(app);
    const menu = await contextMenu(app, POD, ns);
    console.log(`menu: ${JSON.stringify(menu)}`);
    await app.waitFor(async () => (await app.js(`return !!document.activeElement?.closest('[data-testid="context-menu"]')`)), {
      message: "the focus in the menu",
    });
    await bothThemes(app, "menu-open");
    await watchFocus(app, '[data-testid="context-menu"]');
    await shiftTab(app);
    await app.waitFor(async () => (await count(app, '[data-testid="context-menu"]')) === 0, {
      message: "Shift+Tab to close the context menu",
    });
    console.log(`Tab events: ${JSON.stringify((await watched(app)).keys)}`);
    await app.js("window.__qaOff?.()");
    await bothThemes(app, "menu-closed");
  });
});
