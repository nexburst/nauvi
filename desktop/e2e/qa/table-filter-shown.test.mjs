// The table filter matches what the rows show (#512). In the stream-perf
// screenshots "burst" listed 12 of 21 pods whose shown values don't contain
// it: they were Burstable, in the off-by-default QoS column. Now an
// off-by-default column matches only once it is turned on, and a cut name
// (#482) that matches only in its hidden middle is marked, its tooltip
// saying it matches the filter. Light and dark, at 1280x800.
//
// Objects it creates live in a temporary qa-filter-shown-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { closePanel } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const SHORT = "qa512-plain";
const LONG = "qa512-payments-reconciliation-worker-canary-7d9f8b6c5-x7k2p";
const HASH = "7d9f8b6c5";

// Requests below the limits: Burstable.
const pod = (name) => `
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 3600"]
      resources:
        requests: { cpu: 5m, memory: 8Mi }
        limits: { cpu: 50m, memory: 32Mi }
`;

const chooserButton = By.xpath("//button[starts-with(normalize-space(), 'Columns')]");
const choice = (label) => By.xpath(`//*[@role='dialog'][@aria-label='Columns']//label[normalize-space()='${label}']//input`);

/** Turn a column of the chooser on or off. */
async function toggleColumn(app, label) {
  await (await app.find(chooserButton)).click();
  await (await app.find(choice(label))).click();
  await (await app.find(chooserButton)).click();
}

/** The Name cell of the long pod's row: its classes, title, shown text. */
const longCell = (app) =>
  app.js(
    `const cell = [...document.querySelectorAll('[data-testid="resource-row"] [role="gridcell"]')]
       .find((c) => (c.getAttribute("aria-label") ?? c.textContent.trim()) === ${JSON.stringify(LONG)});
     return cell ? { cls: cell.className, title: cell.title, text: cell.textContent.trim() } : null;`,
  );

describe("table filter: matches what the rows show", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-filter-shown", `${pod(SHORT)}\n---\n${pod(LONG)}`);
    waitPodReady(ns, SHORT);
    waitPodReady(ns, LONG);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("table-filter-shown");

  it("a hidden column does not match: \"Burstable\" lists nothing while QoS is off", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await app.nav("Pods");
    await waitLive(app);
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 2, { message: "the two pods of the namespace" });
    // Both pods are Burstable, as are many others; no shown value says so.
    await app.filter("Burstable");
    await app.waitFor(async () => (await tableData(app)).rows.length === 0, { message: "no rows for a hidden column" });
    await app.shot("hidden-column-no-match-dark");
    await setTheme(app, "light");
    await app.shot("hidden-column-no-match-light");
  });

  it("turned on, the QoS column matches, and every row listed shows it", T, async () => {
    const { app } = s;
    await toggleColumn(app, "QoS");
    await app.waitFor(async () => (await tableData(app)).rows.length >= 2, { message: "the Burstable pods" });
    const { rows } = await tableData(app);
    for (const r of rows) assert.equal(r.QoS, "Burstable", `${r.Name} shows why it is listed`);
    assert.ok(rows.some((r) => r.Name === SHORT));
    await app.shot("qos-shown-match-light");
    await toggleColumn(app, "QoS");
    await app.waitFor(async () => (await tableData(app)).rows.length === 0, { message: "QoS off: no rows again" });
  });

  it("a cut name that matches only in its hidden middle is marked", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    // The detail panel takes room: the long name is cut in the middle.
    await app.openDetail("Pods", ns, SHORT);
    await app.filter(HASH);
    await app.waitFor(async () => (await tableData(app)).rows.length === 1, { message: "the long pod alone" });
    const cell = await app.waitFor(longCell, { message: "the long pod's name cell" });
    if (!/\bcut\b/.test(cell.cls)) {
      // Too much room to cut it: the mark is for cut cells only.
      assert.ok(!/\bhit\b/.test(cell.cls), "an uncut cell is not marked");
      console.log("table-filter-shown: the name is not cut at this width", cell);
    } else {
      assert.ok(!cell.text.includes(HASH), `the cut hides ${HASH}: ${cell.text}`);
      assert.match(cell.cls, /\bhit\b/);
      assert.equal(cell.title, `${LONG} (matches the filter)`);
    }
    await app.shot("cut-name-hit-dark");
    await setTheme(app, "light");
    await app.shot("cut-name-hit-light");

    // What the cell shows matches: no mark.
    await app.filter("x7k2p");
    await app.waitFor(async () => !/\bhit\b/.test((await longCell(app))?.cls ?? "hit"), { message: "no mark" });
    await app.shot("cut-name-visible-match-light");
    await closePanel(app);
  });
});
