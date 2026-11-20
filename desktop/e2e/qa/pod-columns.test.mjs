// Off-by-default Pod columns (#378): Controlled By, QoS, IP and Nominated
// Node. A fresh profile shows the usual columns; the column chooser lists
// the four under "More columns", unchecked; turned on, they show what the
// cluster says (the owner ReplicaSet, the QoS class, the pod IP) and survive
// a restart; the Controlled By cell opens the owner, a ReplicaSet or the node
// of a static pod; "Default columns" goes back to the fresh-install set.
//
// Nominated Node is only set on a pod waiting for a preemption, which this
// scenario does not cause on the shared cluster: its cells are checked empty.
//
// Objects it creates live in a temporary qa-pod-columns-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { closePanel, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const DEFAULT = ["Name", "Namespace", "Ready", "Status", "Restarts", "Node", "Age", "CPU", "Memory"];
const EXTRA = ["Controlled by", "QoS", "IP", "Nominated node"];
const DEP = "qa-cols";

// Requests below the limits: Burstable.
const deploymentYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DEP}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ${DEP}
  template:
    metadata:
      labels:
        app: ${DEP}
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 3600"]
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { cpu: 100m, memory: 64Mi }
`;

const chooserButton = By.xpath("//button[starts-with(normalize-space(), 'Columns')]");
const choice = (label) => By.xpath(`//*[@role='dialog'][@aria-label='Columns']//label[normalize-space()='${label}']//input`);
const defaultColumns = By.xpath("//*[@role='dialog'][@aria-label='Columns']//button[normalize-space()='Default columns']");

const headers = async (app) => (await tableData(app)).headers.filter(Boolean);
const SCROLLER = '[data-testid="resource-table"] .scroller';
/** Scroll the table sideways to `x` (or its right end) and return how far it can scroll. */
const scrollTable = (app, x = 1e6) =>
  app.js(`const s = document.querySelector('${SCROLLER}'); s.scrollLeft = ${x}; return s.scrollWidth - s.clientWidth;`);
/** The first owner link on screen, after scrolling the table to it. */
async function ownerLink(app) {
  await scrollTable(app);
  return app.find(By.css('[data-testid="resource-row"] [data-testid="owner-link"]'));
}
const textOf = (app, el) => app.js("return arguments[0].textContent.trim()", el);

describe("pods: off-by-default columns", { timeout: 15 * 60_000 }, () => {
  let ns;
  let rs;
  let pods;
  before(() => {
    ns = tempNamespace("qa-pod-columns", deploymentYaml);
    kubectl(["-n", ns, "rollout", "status", `deploy/${DEP}`, "--timeout=180s"]);
    rs = kubectl(["-n", ns, "get", "rs", "-l", `app=${DEP}`, "-o", "jsonpath={.items[0].metadata.name}"]).trim();
    pods = JSON.parse(kubectl(["-n", ns, "get", "pods", "-l", `app=${DEP}`, "-o", "json"])).items.map((p) => ({
      name: p.metadata.name,
      ip: p.status.podIP,
      qos: p.status.qosClass,
    }));
  });
  after(() => deleteNamespace(ns));
  const s = appSession("pod-columns");

  it("a fresh profile shows the usual columns; the extra ones are listed unchecked", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await app.nav("Pods");
    await waitLive(app);
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 2, { message: "the two pods of the namespace" });
    assert.deepEqual(await headers(app), DEFAULT);
    await (await app.find(chooserButton)).click();
    for (const label of EXTRA) {
      assert.equal(await (await app.find(choice(label))).isSelected(), false, `${label} unchecked`);
    }
    assert.equal(await (await app.find(choice("Node"))).isSelected(), true);
    // Nothing changed yet: no "Default columns".
    assert.equal((await app.driver.findElements(defaultColumns)).length, 0);
    await app.shot("chooser-fresh-dark");
  });

  it("turned on, the columns show the owner, QoS class and IP", T, async () => {
    const { app } = s;
    for (const label of EXTRA) await (await app.find(choice(label))).click();
    await (await app.find(chooserButton)).click();
    await app.waitFor(async () => (await headers(app)).includes("Nominated node"), { message: "the extra columns" });
    assert.deepEqual(await headers(app), [...DEFAULT, ...EXTRA]);
    const rows = (await tableData(app)).rows;
    for (const pod of pods) {
      const r = rows.find((r) => r.Name === pod.name);
      assert.ok(r, `row of ${pod.name}`);
      assert.equal(r["Controlled by"], `ReplicaSet/${rs}`);
      assert.equal(r.QoS, pod.qos);
      assert.equal(r.QoS, "Burstable");
      assert.equal(r.IP, pod.ip);
      assert.equal(r["Nominated node"], "");
    }
    await app.shot("columns-on-dark");
    // They don't fit at 1280 px: the table scrolls sideways to them.
    assert.ok((await scrollTable(app)) > 0, "the table scrolls sideways");
    await app.shot("columns-on-scrolled-dark");
    await setTheme(app, "light");
    await app.shot("columns-on-light");
    // An empty table with the columns on: the header, the calm water.
    await app.filter("nothing-matches-this");
    await app.waitFor(async () => (await tableData(app)).rows.length === 0, { message: "an empty table" });
    assert.deepEqual(await headers(app), [...DEFAULT, ...EXTRA]);
    await app.shot("columns-on-empty-light");
    await setTheme(app, "dark");
    await app.filter(ns);
  });

  it("the choice survives a restart", T, async () => {
    const { app } = s;
    await app.restart();
    await app.nav("Pods");
    await waitLive(app);
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 2, { message: "the pods after the restart" });
    assert.deepEqual(await headers(app), [...DEFAULT, ...EXTRA]);
  });

  it("Controlled By opens the owner ReplicaSet, and a static pod's node", T, async () => {
    const { app } = s;
    const link = await ownerLink(app);
    assert.equal(await textOf(app, link), `ReplicaSet/${rs}`);
    await link.click();
    await waitPanelTitle(app, `${ns}/${rs}`);
    const active = await app.js(`return document.querySelector('nav button.active')?.textContent.trim() ?? ""`);
    assert.match(active, /^ReplicaSets/);
    await app.shot("owner-replicaset-opened");
    await closePanel(app);

    // A static pod is owned by its node: the link opens the Node.
    await app.nav("Pods");
    await app.filter("kube-apiserver");
    await app.waitFor(async () => (await tableData(app)).rows.length > 0, { message: "the kube-apiserver pod" });
    const nodeLink = await ownerLink(app);
    const text = await textOf(app, nodeLink);
    assert.match(text, /^Node\//);
    await nodeLink.click();
    await waitPanelTitle(app, text.slice("Node/".length));
    await app.shot("owner-node-opened");
    await closePanel(app);
  });

  it("Default columns goes back to the usual set", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await app.filter(ns);
    await (await app.find(chooserButton)).click();
    await (await app.find(defaultColumns)).click();
    await app.waitFor(async () => !(await headers(app)).includes("QoS"), { message: "the extra columns gone" });
    assert.deepEqual(await headers(app), DEFAULT);
    await app.shot("default-columns");
    await (await app.find(chooserButton)).click();
  });
});
