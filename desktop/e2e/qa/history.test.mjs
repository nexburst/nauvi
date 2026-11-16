// Back/forward (#223) in WebKitGTK against kind.
// Checks: the header's Back arrow is disabled at start; Back/Forward (the
// arrows, Alt+Left/Right through WebDriver, the mouse's buttons 8/9
// through XTEST) walk through views, the namespace selection and the
// detail panel's object; Alt+Left in the table filter stays with the field;
// going back to a ConfigMap deleted since shows "This ConfigMap was
// deleted." instead of an error. Screenshots at 1280x800, dark and light.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appPid } from "../lib/dock.mjs";
import { panelText, panelTitle, setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { namespaceLabel, pickNamespaces } from "../lib/table.mjs";
import { clickX11, resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };

const configMap = (name) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\ndata:\n  k: v\n`;

/** The header arrows' state. */
function arrows(app) {
  return app.js(`
    const b = (l) => document.querySelector('header button[aria-label="' + l + '"]');
    return { back: !!b("Go back") && !b("Go back").disabled, forward: !!b("Go forward") && !b("Go forward").disabled };
  `);
}

async function clickArrow(app, label) {
  await (await app.find(By.css(`header button[aria-label="${label}"]`))).click();
}

/** Alt+Left / Alt+Right, with Alt released again. */
async function altArrow(app, key) {
  await app.driver.actions().keyDown(Key.ALT).sendKeys(key).keyUp(Key.ALT).perform();
}

/** The table's accessible name ("" without a table: the overview). */
const tableName = (app) => app.js(`return document.querySelector('[role="grid"]')?.getAttribute("aria-label") ?? ""`);

function waitPlace(app, { table, panel, message }) {
  return app.waitFor(
    async () => {
      const [t, p] = [await tableName(app), await panelTitle(app)];
      return (table === undefined || t === table) && (panel === undefined || (panel ? p.includes(panel) : p === ""));
    },
    { message },
  );
}

describe("back/forward navigation", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-history", [configMap("hist-a"), configMap("hist-b"), configMap("hist-gone")].join("---\n"));
  });
  after(() => deleteNamespace(ns));
  const s = appSession("history");

  it("Back and Forward walk through views, namespaces and objects", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await waitLive(app);
    assert.deepEqual(await arrows(app), { back: false, forward: false }, "nothing to go back to at start");
    await app.shot("dark-start");

    await app.openDetail("Config Maps", ns, "hist-a");
    await app.openDetail("Config Maps", ns, "hist-b");
    await pickNamespaces(app, [ns]);
    await app.waitFor(async () => (await namespaceLabel(app)) === ns, { message: `namespace ${ns}` });
    assert.equal((await arrows(app)).back, true);

    await clickArrow(app, "Go back");
    await app.waitFor(async () => (await namespaceLabel(app)) === "All namespaces", {
      message: "Back restores All namespaces",
    });
    assert.match(await panelTitle(app), /hist-b/, "the object stays");
    await altArrow(app, Key.ARROW_LEFT);
    await waitPlace(app, { table: "Config Maps", panel: "", message: "Alt+Left closes the panel (the sidebar click)" });
    await altArrow(app, Key.ARROW_LEFT);
    await waitPlace(app, { table: "Config Maps", panel: "hist-a", message: "Alt+Left back to hist-a" });
    assert.deepEqual(await arrows(app), { back: true, forward: true });
    await app.shot("dark-back-to-a");

    await clickArrow(app, "Go forward");
    await waitPlace(app, { panel: "", message: "Forward: no panel" });
    await altArrow(app, Key.ARROW_RIGHT);
    await waitPlace(app, { panel: "hist-b", message: "Alt+Right: hist-b" });
    await altArrow(app, Key.ARROW_RIGHT);
    await app.waitFor(async () => (await namespaceLabel(app)) === ns, { message: "Alt+Right: the namespace again" });
    assert.equal((await arrows(app)).forward, false, "at the newest entry");
    await setTheme(app, "light");
    await app.shot("light-newest");
  });

  it("the mouse's back and forward buttons (XTEST buttons 8 and 9)", T, async (t) => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    if (!pid) return t.skip("the app's pid is unknown, so XTEST cannot target its window");
    // Over the header's brand, away from anything clickable.
    const at = await app.js(`const r = document.querySelector("header .brand").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
    assert.ok(clickX11(pid, at.x, at.y, 8), "an X11 window to click in");
    await app.waitFor(async () => (await namespaceLabel(app)) === "All namespaces", {
      message: "mouse button 8 goes back",
    });
    clickX11(pid, at.x, at.y, 9);
    await app.waitFor(async () => (await namespaceLabel(app)) === ns, { message: "mouse button 9 goes forward" });
  });

  it("Alt+Left in the filter stays with the field", T, async () => {
    const { app } = s;
    const input = await app.find(By.css('input[aria-label="Filter"]'));
    await input.click();
    const before = await panelTitle(app);
    await altArrow(app, Key.ARROW_LEFT);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await panelTitle(app), before, "the panel did not change");
    assert.equal(await namespaceLabel(app), ns, "the namespaces did not change");
    assert.equal(await app.js(`return document.activeElement?.getAttribute("aria-label")`), "Filter");
    await app.js("document.activeElement?.blur()");
  });

  it("back to a ConfigMap deleted since says it was deleted", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await app.openDetail("Config Maps", ns, "hist-gone");
    await app.openDetail("Config Maps", ns, "hist-a");
    kubectl(["-n", ns, "delete", "configmap", "hist-gone", "--wait=true"]);
    // Back over the sidebar click to hist-gone.
    await altArrow(app, Key.ARROW_LEFT);
    await waitPlace(app, { panel: "", message: "back: no panel" });
    await altArrow(app, Key.ARROW_LEFT);
    await waitPanelTitle(app, "hist-gone");
    await app.waitFor(async () => (await panelText(app)).includes("This ConfigMap was deleted."), {
      message: "the deleted notice",
    });
    assert.doesNotMatch(await panelText(app), /Could not load details/);
    await app.shot("dark-deleted");
    await setTheme(app, "light");
    await app.shot("light-deleted");
    // And on to one that exists.
    await altArrow(app, Key.ARROW_RIGHT);
    await altArrow(app, Key.ARROW_RIGHT);
    await waitPanelTitle(app, "hist-a");
    assert.doesNotMatch(await panelText(app), /was deleted/);
  });
});
