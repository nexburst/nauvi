// QA area 5 (#83): keyboard navigation and the command palette (PR #63) in
// WebKitGTK.
// Checks: Ctrl+K and Ctrl+P reach the page and open the palette; the
// palette finds kinds by kubectl alias (`deploy`), namespaces (`ns `),
// actions (`>`), a CRD's kind and its objects on a cluster with CRDs; `?`
// shows the shortcut help; `/` focuses the filter; ↑/↓, j/k, Home/End move
// the focused row through a long table (300 ConfigMaps) and keep it in
// view, with the frame times logged; Enter opens the row, Ctrl+2 switches
// the panel's tab, Esc closes it; Space selects; Delete opens the confirm
// dialog naming the row; Shift+F10 and the Menu key (sent through XTEST)
// open the row menu, arrows move in it and Esc closes it. Text fields have
// autocorrect, autocapitalise and spellcheck off (#176).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appPid } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { closeNamespacePicker, openNamespacePicker, pickNamespaces } from "../lib/table.mjs";
import { cannotCloseLikeUser, pressX11Keys, resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GROUP = "qa-area5.kubeloupe.dev";
const CRD = `qaareafivewidgets.${GROUP}`;
const COUNT = 300;
let ns;

const crdYaml = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${CRD}
spec:
  group: ${GROUP}
  scope: Namespaced
  names: { plural: qaareafivewidgets, singular: qaareafivewidget, kind: QaAreaFiveWidget, shortNames: [qa5w] }
  versions:
    - name: v1
      served: true
      storage: true
      schema: { openAPIV3Schema: { type: object, x-kubernetes-preserve-unknown-fields: true } }
`;

function configMaps(n) {
  return Array.from(
    { length: n },
    (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: qa-cm-${String(i).padStart(3, "0")}\ndata:\n  i: "${i}"\n`,
  ).join("---\n");
}

/** Focused row: its name and whether it is fully inside the grid's viewport. */
const focusedRow = (app) =>
  app.js(`
    const grid = document.querySelector('[role="grid"]');
    const id = grid?.getAttribute("aria-activedescendant");
    const row = id && document.getElementById(id);
    if (!row) return null;
    const g = grid.getBoundingClientRect(), r = row.getBoundingClientRect();
    return { name: row.querySelectorAll('[role="gridcell"]')[1]?.textContent.trim(), visible: r.top >= g.top - 1 && r.bottom <= g.bottom + 1 };
  `);

const press = (app, ...keys) => app.driver.actions().sendKeys(...keys).perform();
const ctrl = (app, key) => app.driver.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
const count = (app, css) => app.js(`return document.querySelectorAll(arguments[0]).length`, css);

describe("area 5: keyboard and command palette", { timeout: 15 * 60_000 }, () => {
  before(() => {
    kubectl(["apply", "-f", "-"], crdYaml);
    kubectl(["wait", "--for=condition=Established", `crd/${CRD}`, "--timeout=60s"]);
    ns = tempNamespace("qa-area5-keys", configMaps(COUNT));
    kubectl(
      ["-n", ns, "apply", "-f", "-"],
      `apiVersion: ${GROUP}/v1\nkind: QaAreaFiveWidget\nmetadata:\n  name: qa-widget-one\nspec: {}\n`,
    );
  });
  after(() => {
    deleteNamespace(ns);
    try {
      kubectl(["delete", "crd", CRD, "--wait=false", "--ignore-not-found"]);
    } catch (e) {
      console.error(`could not delete crd ${CRD}: ${e.message}`);
    }
  });
  const s = appSession("area-5-keyboard");

  it("Ctrl+K and Ctrl+P open the palette; Esc closes it", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    for (const key of ["k", "p"]) {
      await app.js("document.activeElement?.blur()");
      await ctrl(app, key);
      await app.find(byTestId("command-palette"));
      await press(app, Key.ESCAPE);
      await app.waitFor(async () => (await count(app, '[data-testid="command-palette"]')) === 0, { message: `palette closed (Ctrl+${key})` });
    }
  });

  it("the palette finds kinds by alias, namespaces and the CRD", T, async () => {
    const { app } = s;
    await app.palette("deploy", "Deployments");
    await app.waitFor(async () => (await app.js(`return document.querySelector("nav button.active")?.textContent.trim() ?? ""`)).startsWith("Deployments"), {
      message: "Deployments active",
    });
    // Screenshot the palette with a query typed.
    await app.js("document.activeElement?.blur()");
    await ctrl(app, "k");
    const input = await app.find(By.css('[data-testid="command-palette"] input[role="combobox"]'));
    await input.sendKeys("qa5w");
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[data-testid="command-palette"] [role="option"]')?.textContent ?? ""`)).toLowerCase().replace(/\s+/g, "").includes("qaareafivewidget"),
      { timeout: 30_000, message: "the CRD's kind by its short name" },
    );
    await app.shot("palette-crd");
    await input.sendKeys(Key.ENTER);
    await pickNamespaces(app, [ns]);
    await app.waitFor(async () => (await app.rows()).some(([n]) => n === "qa-widget-one"), { message: "the widget listed" });
    // Objects in the current table.
    await app.palette("qa-widget-one", "qa-widget-one");
    await app.find(byTestId("detail-panel"));
    await press(app, Key.ESCAPE);
    // Namespaces and actions.
    await app.js("document.activeElement?.blur()");
    await ctrl(app, "k");
    const input2 = await app.find(By.css('[data-testid="command-palette"] input[role="combobox"]'));
    await input2.sendKeys(`ns ${ns}`);
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[data-testid="command-palette"] [role="option"]')?.textContent ?? ""`)).includes(ns),
      { message: "the namespace option" },
    );
    await input2.clear();
    await input2.sendKeys(">");
    await app.waitFor(async () => (await count(app, '[data-testid="command-palette"] [role="option"]')) > 0, { message: "action options" });
    console.log(
      `> options: ${JSON.stringify(await app.js(`return Array.from(document.querySelectorAll('[data-testid="command-palette"] [role="option"] .label'), (o) => o.textContent.trim()).slice(0, 10)`))}`,
    );
    await press(app, Key.ESCAPE);
  });

  it("? shows the shortcut help", T, async () => {
    const { app } = s;
    await app.js("document.activeElement?.blur()");
    await press(app, "?");
    const help = await app.find(byTestId("shortcut-help"));
    const text = await app.js("return arguments[0].innerText", help);
    for (const t of ["Command palette", "Settings", "Focus the table filter", "Open the row's menu", "Show or hide the dock"]) {
      assert.ok(text.includes(t), `help lists "${t}"`);
    }
    await app.shot("shortcut-help");
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => (await count(app, '[data-testid="shortcut-help"]')) === 0, { message: "help closed" });
  });

  it(`moves through ${COUNT} ConfigMaps with the keyboard and keeps the row in view`, T, async () => {
    const { app } = s;
    await app.nav("Config Maps");
    await pickNamespaces(app, [ns]);
    await app.waitFor(async () => (await app.js(`return document.querySelector('[role="grid"]')?.getAttribute("aria-rowcount")`)) >= COUNT, {
      timeout: 30_000,
      message: `${COUNT} rows`,
    });
    // `/` focuses the filter; Escape/blur gives the keys back to the table.
    await app.js("document.activeElement?.blur()");
    await press(app, "/");
    assert.equal(await app.js(`return document.activeElement?.getAttribute("aria-label")`), "Filter");
    await app.js("document.activeElement?.blur()");

    await press(app, Key.ARROW_DOWN);
    const first = await focusedRow(app);
    assert.ok(first, "a focused row after ↓");
    await press(app, Key.END);
    await app.waitFor(async () => (await focusedRow(app))?.visible, { message: "the last row in view" });
    const last = await focusedRow(app);
    console.log(`first ${JSON.stringify(first)}, after End ${JSON.stringify(last)}`);
    assert.notEqual(last.name, first.name);
    await press(app, Key.HOME);
    await app.waitFor(async () => (await focusedRow(app))?.name === first.name, { message: "Home goes back to the first row" });

    // Frame times while stepping down 60 rows (j and ↓) and back up 20 (k).
    await app.js(`
      window.__qaFrames = []; let last = performance.now();
      const tick = (t) => { window.__qaFrames.push(t - last); last = t; if (window.__qaFrames.length < 100000) window.__qaRaf = requestAnimationFrame(tick); };
      window.__qaRaf = requestAnimationFrame(tick);`);
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) await press(app, "j", Key.ARROW_DOWN);
    for (let i = 0; i < 20; i++) await press(app, "k");
    const ms = Date.now() - t0;
    const frames = await app.js(`cancelAnimationFrame(window.__qaRaf); return window.__qaFrames.slice(1);`);
    frames.sort((a, b) => a - b);
    const p95 = frames[Math.floor(frames.length * 0.95)];
    const now = await focusedRow(app);
    console.log(
      `80 key presses in ${ms} ms; ${frames.length} frames, p95 ${p95?.toFixed(1)} ms, max ${frames.at(-1)?.toFixed(1)} ms; focused ${JSON.stringify(now)}`,
    );
    assert.ok(now.visible, "the focused row stays in view");
    // The first row is kube-root-ca.crt, then qa-cm-000…: 40 rows down is qa-cm-039.
    assert.equal(first.name, "kube-root-ca.crt");
    assert.equal(now.name, "qa-cm-039", "40 rows down");
  });

  it("Space selects, Enter opens, Ctrl+2 switches tab, Esc closes", T, async () => {
    const { app } = s;
    await press(app, " ");
    await app.waitFor(async () => (await count(app, '[data-testid="resource-row"] input[type="checkbox"]:checked')) === 1, {
      message: "one row selected",
    });
    await press(app, " ");
    await press(app, Key.ENTER);
    await app.find(byTestId("detail-panel"));
    const tab = () => app.js(`return document.querySelector('[data-testid="detail-panel"] [role="tab"][aria-selected="true"]')?.textContent.trim()`);
    const before = await tab();
    await ctrl(app, "2");
    await app.waitFor(async () => (await tab()) !== before, { message: "another tab after Ctrl+2" });
    console.log(`tab ${before} -> ${await tab()}`);
    await app.js("document.activeElement?.blur()");
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => (await count(app, '[data-testid="detail-panel"]')) === 0, { message: "panel closed by Esc" });
  });

  it("Delete opens the confirm dialog for the focused row; Esc cancels", T, async () => {
    const { app } = s;
    const row = await focusedRow(app);
    await press(app, Key.DELETE);
    const dialog = await app.find(byTestId("action-dialog"));
    const text = await app.js("return arguments[0].innerText", dialog);
    assert.ok(text.includes(row.name), `the dialog names ${row.name}: ${text}`);
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => (await count(app, '[data-testid="action-dialog"]')) === 0, { message: "dialog closed" });
    kubectl(["-n", ns, "get", "configmap", row.name]);
  });

  /** On a demo/web pod (its menu has several items), open the row menu with `open`. */
  async function menuCheck(app, open) {
    if ((await app.js(`return document.querySelector("nav button.active")?.firstChild?.textContent.trim()`)) !== "Pods") {
      await app.nav("Pods");
      await pickNamespaces(app, ["demo"]);
      await app.filter("web-");
      await app.waitFor(async () => (await app.rows()).length > 0, { message: "demo/web rows" });
    }
    await app.js("document.activeElement?.blur()");
    if (!(await focusedRow(app))) await press(app, Key.ARROW_DOWN);
    await open();
    const menu = await app.find(byTestId("context-menu"));
    await app.shot("row-menu");
    const focused = () => app.js(`return document.activeElement?.getAttribute("role") === "menuitem" ? document.activeElement.textContent.trim() : null`);
    const a = await app.waitFor(focused, { message: "the first menu item focused" });
    await press(app, Key.ARROW_DOWN);
    const b = await app.waitFor(async () => {
      const f = await focused();
      return f && f !== a ? f : null;
    }, { message: "↓ moves in the menu" });
    console.log(`menu: ${JSON.stringify(await app.js("return arguments[0].innerText", menu))}; focus ${a} -> ${b}`);
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => (await count(app, '[data-testid="context-menu"]')) === 0, { message: "menu closed" });
  }

  it("Shift+F10 opens the row menu, arrows move, Esc closes", T, async () => {
    const { app } = s;
    await menuCheck(app, () => app.driver.actions().keyDown(Key.SHIFT).sendKeys(Key.F10).keyUp(Key.SHIFT).perform());
  });

  it("the Menu key opens the row menu", { ...T, skip: cannotCloseLikeUser() }, async () => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    await menuCheck(app, async () => {
      assert.ok(pressX11Keys(pid, "Menu"), "an X11 window to send the key to");
      await sleep(300);
    });
  });

  it("text fields have autocorrect, autocapitalise and spellcheck off (#176)", T, async () => {
    const { app } = s;
    const notPlain = () =>
      app.js(`
        const want = { autocapitalize: "off", autocorrect: "off", spellcheck: "false", autocomplete: "off" };
        const types = ["", "text", "search", "url", "email", "tel", "password", "number"];
        const bad = [];
        for (const el of document.querySelectorAll("input, textarea")) {
          if (el.tagName === "INPUT" && !types.includes((el.getAttribute("type") || "").toLowerCase())) continue;
          for (const [a, v] of Object.entries(want)) {
            if (el.getAttribute(a) !== v) bad.push((el.getAttribute("aria-label") || el.className) + ": " + a + "=" + el.getAttribute(a));
          }
        }
        return bad;`);
    await app.js("document.activeElement?.blur()");
    await press(app, "/");
    await press(app, "shell demo web");
    assert.equal(await app.js(`return document.activeElement?.value`), "shell demo web", "the filter keeps what was typed");
    assert.deepEqual(await notPlain(app), []);
    await app.shot("filter-typed-lowercase");
    await app.js("document.activeElement.value = ''; document.activeElement.dispatchEvent(new Event('input', { bubbles: true }))");
    await app.js("document.activeElement?.blur()");
    await ctrl(app, "k");
    await app.find(byTestId("command-palette"));
    assert.deepEqual(await notPlain(app), [], "the palette's field");
    await press(app, Key.ESCAPE);
    await openNamespacePicker(app);
    assert.deepEqual(await notPlain(app), [], "with the namespace picker open");
    await closeNamespacePicker(app);
  });
});
