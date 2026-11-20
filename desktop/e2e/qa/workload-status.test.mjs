// The Status column of Deployments, StatefulSets and DaemonSets (#381): one
// word, led by the container squares' shape for its tone. A Deployment with
// an unpullable image and a 10 s progress deadline turns Failed; one scaled
// up behind a slow readiness probe shows Scaling, then Running; a
// StatefulSet at zero replicas is Scaled down; a DaemonSet is Running. Then
// demo/web (Running), the sort, light and dark, and an empty table.
//
// Objects it creates live in a temporary qa-rollout-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 300_000 };

const busybox = (readiness = "") => `
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 3600"]${readiness}`;

const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: steady }
spec:
  replicas: 1
  selector: { matchLabels: { app: steady } }
  template:
    metadata: { labels: { app: steady } }
    spec:${busybox(`
          readinessProbe:
            exec: { command: ["true"] }
            initialDelaySeconds: 25
            periodSeconds: 2`)}
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: broken }
spec:
  replicas: 1
  progressDeadlineSeconds: 10
  selector: { matchLabels: { app: broken } }
  template:
    metadata: { labels: { app: broken } }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: registry.invalid/nauvi-qa/does-not-exist:1
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: idle }
spec:
  replicas: 0
  serviceName: idle
  selector: { matchLabels: { app: idle } }
  template:
    metadata: { labels: { app: idle } }
    spec:${busybox()}
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: agent }
spec:
  selector: { matchLabels: { app: agent } }
  template:
    metadata: { labels: { app: agent } }
    spec:
      tolerations: [{ operator: Exists }]${busybox()}
`;

/** Every row's Status: name -> { word, look, title, colour }. */
const statuses = (app) =>
  app.js(`
    const out = {};
    for (const r of document.querySelectorAll('[data-testid="resource-row"]')) {
      const name = r.querySelectorAll('[role="gridcell"]')[1]?.textContent.trim();
      const s = r.querySelector('[data-testid="rollout-status"]');
      if (!s) continue;
      out[name] = { word: s.textContent.trim(), look: s.dataset.look,
                    title: s.closest('[role="gridcell"]').getAttribute("title"),
                    colour: getComputedStyle(s).color };
    }
    return out;`);

const waitStatus = (app, name, word, timeout = 180_000) =>
  app.waitFor(async () => (await statuses(app))[name]?.word === word, {
    timeout,
    message: `${name} ${word}`,
  });

describe("workloads: the Status column", { timeout: 20 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-rollout", yaml);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("workload-status");

  it("Deployments: Status after Name and Namespace; a stuck rollout is Failed", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await app.nav("Deployments");
    await waitLive(app);
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 2, { message: "the two deployments" });
    const { headers } = await tableData(app);
    assert.deepEqual(headers.filter(Boolean).slice(0, 3), ["Name", "Namespace", "Status"]);
    await waitStatus(app, "steady", "Running");
    await waitStatus(app, "broken", "Failed");
    const st = await statuses(app);
    assert.equal(st.broken.look, "bad");
    assert.equal(st.broken.title, "Failed: Rollout stalled (ProgressDeadlineExceeded)");
    assert.equal(st.steady.look, "ok");
    assert.notEqual(st.broken.colour, st.steady.colour);
    await app.shot("failed-dark");
    await setTheme(app, "light");
    await app.shot("failed-light");
  });

  it("scaling up behind a slow readiness probe shows Scaling, then Running", T, async () => {
    const { app } = s;
    kubectl(["-n", ns, "scale", "deployment/steady", "--replicas=3"]);
    await waitStatus(app, "steady", "Scaling", 60_000);
    const st = await statuses(app);
    assert.equal(st.steady.look, "warn");
    assert.match(st.steady.title, /^Scaling: \d of 3 ready$/);
    await app.shot("scaling-light");
    await setTheme(app, "dark");
    await app.shot("scaling-dark");
    await waitStatus(app, "steady", "Running", 120_000);
  });

  it("sorting by Status puts the failed rollout first", T, async () => {
    const { app } = s;
    const head = await app.find(By.xpath("//*[@role='columnheader'][starts-with(normalize-space(), 'Status')]"));
    await head.click();
    await head.click();
    const first = await app.js(`
      const rows = Array.from(document.querySelectorAll('[data-testid="resource-row"]'));
      rows.sort((a, b) => Number(a.getAttribute("aria-rowindex")) - Number(b.getAttribute("aria-rowindex")));
      return rows[0]?.querySelectorAll('[role="gridcell"]')[1]?.textContent.trim();`);
    assert.equal(first, "broken");
  });

  it("StatefulSets: zero replicas is Scaled down; DaemonSets: Running", T, async () => {
    const { app } = s;
    await app.nav("StatefulSets");
    await app.filter(ns);
    await waitStatus(app, "idle", "Scaled down", 60_000);
    assert.equal((await statuses(app)).idle.look, "done");
    await app.shot("statefulset-dark");
    await app.nav("DaemonSets");
    await app.filter(ns);
    await waitStatus(app, "agent", "Running");
    await app.shot("daemonset-dark");
  });

  it("demo/web is Running", T, async (t) => {
    const { app } = s;
    await app.nav("Deployments");
    await app.filter("demo");
    const found = await waitStatus(app, "web", "Running", 30_000).then(
      () => true,
      () => false,
    );
    if (!found) {
      t.skip("no demo/web on this cluster");
      return;
    }
    await setTheme(app, "light");
    await app.shot("demo-light");
  });

  it("an empty table keeps the Status header", T, async () => {
    const { app } = s;
    await app.filter("nothing-matches-this");
    await app.waitFor(async () => (await tableData(app)).rows.length === 0, { message: "an empty table" });
    assert.ok((await tableData(app)).headers.includes("Status"));
    await app.shot("empty-light");
  });
});
