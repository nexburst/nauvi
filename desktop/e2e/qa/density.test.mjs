// Table and detail density (#384), and the toolbar beside the inspector
// (part of #392), in WebKitGTK at 1280x800:
// - table headers keep the #390 style (mono capitals); labels are sentence case;
// - the default Pods table still fits without scrolling sideways;
// - Deployments: the short columns stay narrow and Name takes the slack;
// - the detail panel opens at 420 px; a long pod name is one line, cut, with
//   its whole value in the title; the panel never scrolls sideways;
// - with a long namespace picked and the inspector open, "+ Create" stays on
//   the toolbar's row;
// - all of it in light and dark, with normal and then compact rows (#355).
// A pod with a long node name cannot be made on kind (the pod GC deletes pods
// bound to a node that does not exist); the Playwright spec covers it.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { closePanel, setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";

const T = { timeout: 180_000 };
const POD = `qa-density-pod-${"with-a-long-name-".repeat(4)}end`;

const yaml = `apiVersion: v1
kind: Pod
metadata:
  name: ${POD}
spec:
  terminationGracePeriodSeconds: 0
  containers: [{ name: pause, image: registry.k8s.io/pause:3.10 }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qa-density-web
spec:
  replicas: 1
  selector: { matchLabels: { app: qa-density-web } }
  template:
    metadata: { labels: { app: qa-density-web } }
    spec:
      terminationGracePeriodSeconds: 0
      containers: [{ name: pause, image: registry.k8s.io/pause:3.10 }]
`;

/** The headers' style against the cells', and whether the table scrolls sideways. */
const tableStyle = (app) =>
  app.js(`
    const grid = document.querySelector('[data-testid="resource-table"] [role="grid"]');
    const heads = Array.from(grid.querySelectorAll('.head [role="columnheader"]')).filter((h) => h.querySelector('.label'));
    const cell = grid.querySelector('[data-testid="resource-row"] [role="gridcell"]:nth-child(2)');
    const scroller = grid.querySelector('.scroller');
    const width = (label) => heads.find((h) => h.querySelector('.label').textContent.trim() === label)?.getBoundingClientRect().width ?? 0;
    return {
      labels: heads.map((h) => h.querySelector('.label').textContent.trim()),
      transform: getComputedStyle(heads[0]).textTransform,
      headSize: getComputedStyle(heads[0]).fontSize,
      cellSize: cell ? getComputedStyle(cell).fontSize : "",
      sideways: scroller.scrollWidth - scroller.clientWidth,
      rowHeight: grid.querySelector('[data-testid="resource-row"]')?.getBoundingClientRect().height ?? 0,
      widths: Object.fromEntries(["Name", "Namespace", "Status", "Ready", "Up-to-date", "Available", "Age"].map((l) => [l, Math.round(width(l))])),
    };`);

const panelLayout = (app) =>
  app.js(`
    const p = document.querySelector('[data-testid="detail-panel"]');
    const dds = Array.from(p.querySelectorAll('dl.meta dd'));
    const name = dds.find((d) => d.textContent.trim().startsWith('qa-density-pod-'));
    const s = getComputedStyle(name);
    return {
      panel: Math.round(p.getBoundingClientRect().width),
      sideways: p.scrollWidth - p.clientWidth,
      name: { title: name.title, height: name.getBoundingClientRect().height, line: parseFloat(s.lineHeight) || 1.4 * parseFloat(s.fontSize),
              cut: name.scrollWidth > name.clientWidth, ellipsis: s.textOverflow },
    };`);

const toolbarLayout = (app) =>
  app.js(`
    const bar = document.querySelector('.toolbar').getBoundingClientRect();
    const create = Array.from(document.querySelectorAll('.toolbar button')).find((b) => b.textContent.trim() === '+ Create').getBoundingClientRect();
    const picker = document.querySelector('.toolbar button[aria-label="Namespace"]');
    return { height: bar.height, createTop: create.top - bar.top, createRight: bar.right - create.right,
             picker: { text: picker.textContent.trim(), title: picker.title, width: picker.getBoundingClientRect().width } };`);

let ns;

describe("table and detail density (#384), toolbar one row (#392)", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-density-long-namespace", yaml);
    kubectl(["-n", ns, "wait", "--for=condition=Ready", "pod", POD, "--timeout=180s"]);
    kubectl(["-n", ns, "rollout", "status", "deployment/qa-density-web", "--timeout=180s"]);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("density");

  async function checkPods(app, theme, rows) {
    if ((await app.driver.findElements(By.css('[data-testid="detail-panel"]'))).length) await closePanel(app);
    await setTheme(app, theme);
    await app.nav("Pods");
    await pickNamespaces(app, []);
    await app.filter("");
    await app.find(app.row(POD, ns), { timeout: 60_000 });
    const t = await tableStyle(app);
    console.log(`pods ${theme} ${rows}: ${JSON.stringify(t)}`);
    assert.equal(t.transform, "uppercase", "headers keep the #390 capitals");
    assert.ok(t.labels.includes("Name") && t.labels.includes("Restarts"), `sentence-case labels: ${t.labels}`);
    assert.ok(t.sideways <= 0, `the default Pods table fits 1280 px (${t.sideways} px over)`);
    assert.equal(Math.round(t.rowHeight), rows === "compact" ? 22 : 28, "row height");
  }

  async function checkDetail(app, theme) {
    await setTheme(app, theme);
    await app.nav("Pods");
    await pickNamespaces(app, [ns]);
    await app.filter("");
    await (await app.find(app.row(POD, ns), { timeout: 60_000 })).click();
    await waitPanelTitle(app, `${ns}/${POD}`);
    const p = await app.waitFor(async () => {
      const l = await panelLayout(app);
      return l.name ? l : null;
    }, { message: "the pod's details" });
    console.log(`detail ${theme}: ${JSON.stringify(p)}`);
    assert.ok(Math.abs(p.panel - 420) <= 2, `panel width ${p.panel}`);
    assert.ok(p.sideways <= 0, `the panel does not scroll sideways (${p.sideways})`);
    assert.equal(p.name.title, POD);
    assert.ok(p.name.height < p.name.line * 1.5, `the name is one line (${p.name.height} px)`);
    assert.ok(p.name.cut, "the long name is cut");
    assert.equal(p.name.ellipsis, "ellipsis");
    const tb = await toolbarLayout(app);
    console.log(`toolbar ${theme}: ${JSON.stringify(tb)}`);
    assert.ok(tb.height <= 60, `the toolbar is one row (${tb.height} px)`);
    assert.ok(tb.createTop < 30 && tb.createRight >= 0, `+ Create on the row: ${JSON.stringify(tb)}`);
    assert.equal(tb.picker.title, ns);
  }

  for (const theme of ["light", "dark"]) {
    it(`Pods: header labels, fits 1280 px (${theme})`, T, async () => {
      await waitLive(s.app);
      await checkPods(s.app, theme, "normal");
    });

    it(`Deployments: Name takes the slack (${theme})`, T, async () => {
      const { app } = s;
      await setTheme(app, theme);
      await app.nav("Deployments");
      await pickNamespaces(app, [ns]);
      await app.find(app.row("qa-density-web", ns), { timeout: 60_000 });
      const t = await tableStyle(app);
      console.log(`deployments ${theme}: ${JSON.stringify(t)}`);
      for (const l of ["Ready", "Up-to-date", "Available"]) assert.ok(t.widths[l] <= 112, `${l} stays narrow: ${t.widths[l]}`);
      assert.ok(t.widths.Name > 2 * t.widths["Up-to-date"], `Name takes the slack: ${JSON.stringify(t.widths)}`);
    });

    it(`pod detail: 420 px, a long name on one line with a title; toolbar one row (${theme})`, T, async () => {
      await checkDetail(s.app, theme);
    });
  }

  it("compact rows: restart with row_height compact", T, async () => {
    const { app } = s;
    await app.restart({ beforeStart: () => app.profile.writeSettings({ ...(app.profile.settings() ?? {}), row_height: "compact" }) });
    await waitLive(app);
  });

  for (const theme of ["light", "dark"]) {
    it(`compact Pods: headers, fit, 22 px rows (${theme})`, T, async () => {
      await checkPods(s.app, theme, "compact");
    });
    it(`compact pod detail and toolbar (${theme})`, T, async () => {
      await checkDetail(s.app, theme);
    });
  }
});
