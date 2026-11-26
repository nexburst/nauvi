// Fitted tables (#482) and the row menu's Edit YAML (#494), in the real app.
//
// Two Deployments whose pods have long generated names that differ only at
// the end (payments-worker-canary-<hash>-<id>, payments-worker-<hash>-<id>),
// as in the task-flow audit (#486). Checked, in light and dark:
// - Pods at 1280x800: the pod names are whole, Ready, Status, Restarts and
//   Age are never cut and stay narrow, anything cut has its whole value as
//   tooltip and name, and the table does not scroll sideways.
// - With the detail panel open, and in a narrow window: a cut name keeps
//   its end (the two pods still read differently) and has its whole value
//   as tooltip and name; Ready, Status, Restarts and Age are never cut.
// - Status cells lead with an icon.
// - Hovering a row shows its Logs, Shell and Edit YAML; Edit YAML opens the
//   YAML tab.
// - The ⋮ menu of a Deployment and of a Pod has Edit YAML (with its key) after
//   Logs/Shell; Rollout restart from the menu asks first.
// - A header edge drags to resize; the width is kept across kinds; a
//   double-click fits the column again.
//
// Objects live in a temporary qa-tablefit-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key, Origin } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { closePanel, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { closeMenu } from "./area-2-helpers.mjs";

const T = { timeout: 240_000 };
const DEPLOYS = ["payments-worker-canary", "payments-worker"];

const deployYaml = DEPLOYS.map(
  (name) => `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 1
  selector: { matchLabels: { app: ${name} } }
  template:
    metadata: { labels: { app: ${name} } }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 36000"]
`,
).join("");

/**
 * Every rendered row's cells, by column label: the text shown, whether it is
 * cut (the class, or wider than its cell), its tooltip and name; plus the
 * column widths and whether the table scrolls sideways.
 */
const layout = (app) =>
  app.js(`
    const table = document.querySelector('[data-testid="resource-table"]');
    const heads = Array.from(table.querySelectorAll('.head [role="columnheader"]'));
    const labels = heads.map((h) => h.textContent.replace(/[▲▼]/g, "").trim());
    const rows = Array.from(table.querySelectorAll('[data-testid="resource-row"]'), (r) => {
      const cells = r.querySelectorAll('[role="gridcell"]');
      const o = {};
      labels.forEach((l, i) => {
        const c = cells[i];
        if (!l || !c) return;
        const inner = c.querySelector('.linked-text, .cell-link') ?? c;
        o[l] = { text: c.textContent.trim(), cut: c.classList.contains("cut") || inner.scrollWidth > inner.clientWidth + 1,
                 title: c.getAttribute("title") ?? "", name: c.getAttribute("aria-label") ?? "",
                 icon: c.querySelector("svg[data-icon]")?.dataset.icon ?? "" };
      });
      return o;
    });
    const widths = Object.fromEntries(heads.map((h, i) => [labels[i], Math.round(h.getBoundingClientRect().width)]));
    const s = table.querySelector(".scroller");
    return { rows, widths, sideways: s.scrollWidth - s.clientWidth };`);

const payments = (l) => l.rows.filter((r) => (r.Name?.name || r.Name?.text || "").startsWith("payments-worker"));
const SHORT = ["Ready", "Status", "Restarts", "Age"];

/** Every cut cell says what it cuts: its whole value as tooltip and name. */
function assertCutsExplained(what, l) {
  for (const r of l.rows)
    for (const [k, c] of Object.entries(r)) {
      if (!c.cut || k === "") continue;
      assert.ok(c.name && c.title === c.name, `${what}: ${k} "${c.text}" is cut without its whole value (${c.title})`);
    }
  for (const r of l.rows) for (const k of SHORT) if (r[k]) assert.ok(!r[k].cut, `${what}: ${k} "${r[k].text}" is cut`);
}

function assertNamesWhole(what, l) {
  console.log(`${what}: widths ${JSON.stringify(l.widths)}, sideways ${l.sideways}`);
  const cut = l.rows.flatMap((r) => Object.entries(r).filter(([, c]) => c.cut).map(([k, c]) => `${k}: ${c.text}`));
  console.log(`${what}: cut ${JSON.stringify(cut)}`);
  for (const r of payments(l)) assert.ok(!r.Name.cut, `${what}: ${r.Name.text} is cut`);
  assertCutsExplained(what, l);
  assert.ok(l.sideways <= 1, `${what}: scrolls sideways by ${l.sideways}px`);
  for (const k of ["Ready", "Restarts", "Age"]) assert.ok(l.widths[k] <= 120, `${what}: ${k} is ${l.widths[k]}px wide`);
}

function assertCutWell(what, l, { canary = false } = {}) {
  console.log(`${what}: widths ${JSON.stringify(l.widths)}, sideways ${l.sideways}`);
  const [a, b] = payments(l);
  assert.ok(a && b, `${what}: both payments pods are rendered`);
  // Shown differently, each a prefix…suffix of the whole name, which is its tooltip and name.
  assert.notEqual(a.Name.text, b.Name.text, `${what}: the two names read differently`);
  for (const r of [a, b]) {
    if (!r.Name.cut) continue;
    const whole = r.Name.name;
    assert.equal(r.Name.title, whole, `${what}: tooltip of ${r.Name.text}`);
    const [head, tail] = r.Name.text.split("…");
    assert.ok(whole.startsWith(head) && whole.endsWith(tail), `${what}: ${r.Name.text} is cut from ${whole}`);
    assert.ok(whole.endsWith(whole.slice(whole.lastIndexOf("-"))) && r.Name.text.endsWith(whole.slice(whole.lastIndexOf("-"))), `${what}: ${r.Name.text} keeps its suffix`);
  }
  // With some room, the part that tells them apart stays (the hash goes first).
  if (canary) assert.ok(payments(l).some((r) => r.Name.text.includes("canary")), `${what}: "canary" is shown`);
  assertCutsExplained(what, l);
}

async function showPods(app, ns) {
  await app.nav("Pods");
  await pickNamespaces(app, [ns]);
  await app.filter("payments");
  await app.waitFor(async () => payments(await layout(app)).length === 2, { timeout: 120_000, message: "both payments pods" });
}

let ns;

describe("tables: fitted columns, row actions, Edit YAML (#482, #494)", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-tablefit", deployYaml);
    kubectl(["-n", ns, "rollout", "status", "deployment/payments-worker", "--timeout=180s"]);
    kubectl(["-n", ns, "rollout", "status", "deployment/payments-worker-canary", "--timeout=180s"]);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("table-fit");

  for (const theme of ["light", "dark"]) {
    it(`Pods at 1280x800: names whole, short columns narrow (${theme})`, T, async () => {
      const { app } = s;
      await waitLive(app);
      await resizeWindow(app, 1280, 800);
      if ((await app.driver.findElements(byTestId("detail-panel"))).length) await closePanel(app);
      await setTheme(app, theme);
      await showPods(app, ns);
      const l = await layout(app);
      assertNamesWhole(`pods ${theme}`, l);
      for (const r of payments(l)) assert.equal(r.Status.icon, "ok", `status icon of ${r.Name.text}`);
    });

    it(`Pods with the detail panel open: cut names keep their end (${theme})`, T, async () => {
      const { app } = s;
      const [first] = payments(await layout(app));
      await (await app.find(app.row(first.Name.name || first.Name.text))).click();
      await waitPanelTitle(app, `${ns}/`);
      assertCutWell(`pods + panel ${theme}`, await layout(app));
    });

    it(`Pods in a narrow window, without and with the panel (${theme})`, T, async () => {
      const { app } = s;
      await resizeWindow(app, 1024, 768);
      assertCutWell(`narrow + panel ${theme}`, await layout(app));
      await app.shot(`narrow-panel-${theme}`);
      await closePanel(app);
      assertCutWell(`narrow ${theme}`, await layout(app));
      await resizeWindow(app, 1280, 800);
    });
  }

  it("all namespaces, filter payments: namespace and age whole (#486)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.nav("Pods");
    await pickNamespaces(app, []);
    await app.filter("payments");
    await app.waitFor(async () => payments(await layout(app)).length === 2, { message: "both payments pods" });
    const l = await layout(app);
    assertNamesWhole("all namespaces", l);
  });

  it("a hovered row shows Logs, Shell and Edit YAML; Edit YAML opens the YAML tab", T, async () => {
    const { app } = s;
    await showPods(app, ns);
    const [first] = payments(await layout(app));
    const name = first.Name.name || first.Name.text;
    const row = await app.find(app.row(name));
    await app.driver.actions().move({ origin: row }).perform();
    const quick = await app.waitFor(
      async () => {
        const labels = await app.js(
          `return Array.from(arguments[0].querySelectorAll('[data-testid="row-quick"] button'), (b) => b.getAttribute("aria-label"))`,
          row,
        );
        return labels.length > 0 ? labels : null;
      },
      { message: "the row's quick actions" },
    );
    assert.deepEqual(quick, [`Logs of ${name}`, `Shell of ${name}`, `Edit YAML of ${name}`]);
    await app.shot("hover-light");
    await setTheme(app, "dark");
    await app.driver.actions().move({ origin: row, x: 5 }).perform();
    await app.shot("hover-dark");
    await (await row.findElement(By.css('[data-testid="row-edit"]'))).click();
    await waitPanelTitle(app, `${ns}/${name}`);
    // A pod's panel scrolls to its YAML editor.
    await app.waitFor(
      () =>
        app.js(`const e = document.querySelector('[data-testid="detail-panel"] [data-testid="yaml-editor"]');
                if (!e) return false;
                const r = e.getBoundingClientRect();
                return r.top < innerHeight && r.bottom > 0;`),
      { message: "the YAML editor in view" },
    );
    await closePanel(app);
  });

  it("the keyboard's row shows its quick actions too (#507)", T, async () => {
    const { app } = s;
    await showPods(app, ns);
    // The pointer off the rows, the focus in the grid.
    await app.driver.actions().move({ origin: Origin.VIEWPORT, x: 5, y: 5 }).perform();
    await app.js(`document.querySelector('[role="grid"]').focus()`);
    await app.driver.actions().sendKeys(Key.ARROW_DOWN).perform();
    const focusedQuick = () =>
      app.js(`
        const grid = document.querySelector('[role="grid"]');
        const id = grid?.getAttribute("aria-activedescendant");
        const row = id && document.getElementById(id);
        return {
          focused: row ? row.querySelectorAll('[data-testid="row-quick"] button').length : -1,
          all: document.querySelectorAll('[data-testid="row-quick"]').length,
        };`);
    await app.waitFor(async () => (await focusedQuick()).focused === 3, { message: "the focused row's quick actions" });
    assert.equal((await focusedQuick()).all, 1, "only the focused row shows them");
    for (const theme of ["light", "dark"]) {
      await setTheme(app, theme);
      await app.shot(`focused-quick-${theme}`);
    }
    // They go with the focus.
    await app.js(`document.activeElement?.blur()`);
    await app.waitFor(async () => (await focusedQuick()).all === 0, { message: "no quick actions without focus" });
  });

  for (const [kind, name, first] of [
    ["Deployments", "payments-worker", ["Logs", "Edit YAML"]],
    ["Pods", null, ["Logs", "Shell", "Edit YAML"]],
  ]) {
    it(`the ${kind} row menu has Edit YAML with its key`, T, async () => {
      const { app } = s;
      await setTheme(app, "light");
      await app.nav(kind);
      await app.filter("payments-worker");
      const target = name ?? payments(await layout(app))[0].Name.text;
      const row = await app.find(app.row(target));
      await (await row.findElement(byTestId("row-menu"))).click();
      await app.find(byTestId("context-menu"));
      const items = await app.js(`
        return Array.from(document.querySelectorAll('[data-testid="context-menu"] .item'), (i) =>
          [i.querySelector('[role="menuitem"]').textContent.trim(), i.querySelector("kbd")?.textContent ?? ""]);`);
      console.log(`${kind} menu: ${JSON.stringify(items)}`);
      assert.deepEqual(items.slice(0, first.length).map(([l]) => l), first);
      assert.deepEqual(items.find(([l]) => l === "Edit YAML"), ["Edit YAML", "E"]);
      if (kind === "Deployments") assert.deepEqual(items.find(([l]) => l === "Rollout restart"), ["Rollout restart", "⇧R"]);
      await app.shot(`menu-${kind.toLowerCase()}`);
      if (kind === "Deployments") {
        await (await app.find(By.xpath(`//*[@data-testid='context-menu']//*[@role='menuitem'][normalize-space()='Rollout restart']`))).click();
        await app.find(byTestId("action-dialog"));
        await app.shot("restart-asks");
        await app.driver.actions().sendKeys(Key.ESCAPE).perform();
        await app.waitFor(async () => (await app.driver.findElements(byTestId("action-dialog"))).length === 0, {
          message: "the dialog to close",
        });
      } else await closeMenu(app);
    });
  }

  it("a header edge drags to resize, is kept, and double-click fits", T, async () => {
    const { app } = s;
    await showPods(app, ns);
    const width = async () => (await layout(app)).widths.Namespace;
    const before = await width();
    const handle = await app.find(By.css('[data-testid="col-resize"][data-col="namespace"]'));
    await app.driver
      .actions()
      .move({ origin: handle })
      .press()
      .move({ origin: Origin.POINTER, x: 40, y: 0 })
      .move({ origin: Origin.POINTER, x: 40, y: 0 })
      .release()
      .perform();
    await app.waitFor(async () => (await width()) >= before + 60, { message: `Namespace wider than ${before}px` });
    const sized = await width();
    await app.shot("resized");
    await app.nav("Deployments");
    await app.nav("Pods");
    await app.waitFor(async () => Math.abs((await width()) - sized) <= 1, { message: `Namespace kept at ${sized}px` });
    await app.driver.actions().doubleClick(await app.find(By.css('[data-testid="col-resize"][data-col="namespace"]'))).perform();
    await app.waitFor(async () => Math.abs((await width()) - before) <= 1, { message: `Namespace back to ${before}px` });
  });
});
