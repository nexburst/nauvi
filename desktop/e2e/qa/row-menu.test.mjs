// The row's ⋮ menu and the cells that act as links (#382), in the real app.
// A Pods table at 1280x800 with its ⋮ column: the ⋮ opens the same menu as a
// right-click (title, items and greyed items), Shift+F10 opens it from the
// keyboard, the Namespace cell shows the Pods of that namespace, and the
// Node cell opens the node's detail. Light and dark, and an empty table.
//
// Objects it creates live in a temporary qa-rowmenu-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { namespaceLabel, pickNamespaces, tableData } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { closeMenu, contextMenu } from "./area-2-helpers.mjs";

const T = { timeout: 240_000 };
const POD = "qa-rowmenu";

const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: ${POD}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 3600"]
`;

/** The open menu: its title, and every item with whether it is offered. */
const openMenu = (app) =>
  app.js(`
    const m = document.querySelector('[data-testid="context-menu"]');
    if (!m) return null;
    return { title: m.querySelector('.title')?.textContent.trim() ?? "",
             items: Array.from(m.querySelectorAll('[role="menuitem"]'),
               (b) => b.textContent.trim() + (b.disabled ? " (off)" : "")) };`);

/** The ⋮ button of the pod's row, and where it is against the table. */
const moreButton = (app) =>
  app.js(`
    const row = Array.from(document.querySelectorAll('[data-testid="resource-row"]'))
      .find((r) => r.querySelectorAll('[role="gridcell"]')[1]?.textContent.trim() === ${JSON.stringify(POD)});
    const b = row?.querySelector('[data-testid="row-menu"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const edge = b.closest(".scroller").getBoundingClientRect().right;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { label: b.getAttribute("aria-label"), inside: r.right <= edge, onTop: top?.closest('[data-testid="row-menu"]') === b };`);

const clickInRow = (app, testId) =>
  app.js(
    `const row = Array.from(document.querySelectorAll('[data-testid="resource-row"]'))
       .find((r) => r.querySelectorAll('[role="gridcell"]')[1]?.textContent.trim() === ${JSON.stringify(POD)});
     const el = row?.querySelector('[data-testid="${testId}"]');
     return el ? el : null;`,
  );

/** Hover the pod's row (the links show on hover), then click one of them. */
async function clickLink(app, testId) {
  const link = await clickInRow(app, testId);
  const row = await app.js(`return arguments[0].closest('[data-testid="resource-row"]')`, link);
  await app.driver.actions().move({ origin: row }).perform();
  await app.waitFor(async () => (await app.js("return getComputedStyle(arguments[0]).opacity", link)) === "1", {
    message: `${testId} shown on hover`,
  });
  await app.shot(`${testId}-hover`);
  await link.click();
}

describe("tables: the row ⋮ menu and cell links", { timeout: 15 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-rowmenu", podYaml);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("row-menu");

  it("the ⋮ opens the right-click menu, under the button", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await app.nav("Pods");
    await waitLive(app);
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 1, { message: "the pod of the namespace" });
    const more = await moreButton(app);
    assert.equal(more.label, `Actions for ${POD}`);
    assert.ok(more.inside && more.onTop, `the ⋮ is whole and on top: ${JSON.stringify(more)}`);

    await contextMenu(app, POD);
    // Greying arrives with the access check: give it a moment.
    await new Promise((r) => setTimeout(r, 1500));
    const byRightClick = await openMenu(app);
    await closeMenu(app);

    await (await clickInRow(app, "row-menu")).click();
    await app.find(byTestId("context-menu"));
    await new Promise((r) => setTimeout(r, 1500));
    const byButton = await openMenu(app);
    assert.deepEqual(byButton, byRightClick);
    assert.equal(byButton.title, `${ns}/${POD}`);
    // Neither opened the detail.
    assert.equal((await app.driver.findElements(byTestId("detail-panel"))).length, 0);
    await app.shot("menu-dark");
    await setTheme(app, "light");
    await app.shot("menu-light");
    await closeMenu(app);
  });

  it("Shift+F10 opens the same menu for the focused row", T, async () => {
    const { app } = s;
    await app.js(`document.querySelector('[role="grid"]').focus()`);
    await app.driver.actions().sendKeys(Key.ARROW_DOWN).perform();
    await app.driver.actions().keyDown(Key.SHIFT).sendKeys(Key.F10).keyUp(Key.SHIFT).perform();
    await app.find(byTestId("context-menu"));
    assert.equal((await openMenu(app)).title, `${ns}/${POD}`);
    await closeMenu(app);
  });

  it("the Namespace cell shows the Pods of that namespace", T, async () => {
    const { app } = s;
    await app.filter("");
    await app.waitFor(async () => (await tableData(app)).rows.length > 1, { message: "every pod" });
    await app.filter(POD);
    await app.waitFor(async () => (await tableData(app)).rows.length === 1, { message: "the pod" });
    await clickLink(app, "namespace-link");
    await app.waitFor(async () => (await namespaceLabel(app)) === ns, { message: `the picker on ${ns}` });
    assert.equal((await app.driver.findElements(byTestId("detail-panel"))).length, 0);
    await app.filter("");
    await app.waitFor(async () => (await tableData(app)).rows.length === 1, { message: "only the namespace's pod" });
    await app.shot("namespace-light");
  });

  it("the Node cell opens the node's detail", T, async () => {
    const { app } = s;
    await app.waitFor(async () => (await tableData(app)).rows[0]?.Node, { timeout: 120_000, message: "the pod scheduled" });
    const node = (await tableData(app)).rows[0].Node;
    await clickLink(app, "node-link");
    await waitPanelTitle(app, node);
    const active = await app.js(`return document.querySelector('nav button.active')?.textContent.trim() ?? ""`);
    assert.match(active, /^Nodes/);
    await app.shot("node-light");
    await setTheme(app, "dark");
    await app.shot("node-dark");
  });

  it("an empty table keeps the header, with no ⋮", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await pickNamespaces(app, []);
    await app.filter("nothing-matches-this");
    await app.waitFor(async () => (await tableData(app)).rows.length === 0, { message: "an empty table" });
    assert.equal((await app.driver.findElements(byTestId("row-menu"))).length, 0);
    await app.shot("empty-dark");
  });
});
