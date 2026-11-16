// QA area 1 (#83): live tables for Pods, Nodes and Namespaces.
// Checks (#19, #21): the Pods table fills and goes Live; `kubectl run`,
// `delete pod` and `scale` update rows without losing the scroll position or
// the selected row; the filter and header sorting work; the namespace control
// narrows the watch; Ready/Restarts/Status are right (demo/crashed is
// crash-looping); CPU/Memory fill in (metrics-server) and ages tick; a row
// click opens the pod panel; Nodes show CPU/memory as `used / capacity`;
// the Namespaces table shows a namespace created and deleted with kubectl.
//
// Objects it changes live in a temporary qa-area1-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, podNames, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData, pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deploymentYaml = (name, replicas) => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 3600"]
`;

const scrollTop = (app) =>
  app.js(`return document.querySelector('[data-testid="resource-table"] .scroller')?.scrollTop ?? -1`);

describe("area 1: live Pods, Nodes and Namespaces tables", { timeout: 15 * 60_000 }, () => {
  let ns;
  let extraNs;
  const dep = "qa-area1-app";
  before(() => {
    ns = tempNamespace("qa-area1-tables", deploymentYaml(dep, 1));
    kubectl(["-n", ns, "rollout", "status", `deploy/${dep}`, "--timeout=180s"]);
  });
  after(() => {
    deleteNamespace(ns);
    deleteNamespace(extraNs);
  });
  const s = appSession("area-1-tables");

  it("Pods fills and goes Live; demo/crashed shows its restarts and status", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    assert.deepEqual(
      (await tableData(app)).headers.filter(Boolean),
      ["Name", "Namespace", "Ready", "Status", "Restarts", "Node", "Age", "CPU", "Memory"],
    );
    await app.filter("crashed");
    // It runs for a moment between back-offs: wait for the back-off.
    const row = await app
      .waitFor(
        async () => {
          const r = (await tableData(app)).rows.find((r) => r.Name === "crashed" && r.Namespace === "demo");
          return r && /CrashLoopBackOff|Error/.test(r.Status) ? r : null;
        },
        { timeout: 90_000, message: "the demo/crashed row in CrashLoopBackOff or Error" },
      )
      .catch((e) => {
        // What the cluster says, to tell a stale row from a slow kubelet.
        const status = kubectl(["-n", "demo", "get", "pod", "crashed", "-o", "jsonpath={.status.containerStatuses[0]}"]);
        throw new Error(`${e.message}; kubectl: ${status}`);
      });
    console.log(`crashed: ${JSON.stringify(row)}`);
    const want = JSON.parse(kubectl(["-n", "demo", "get", "pod", "crashed", "-o", "json"]));
    const cs = want.status.containerStatuses[0];
    assert.match(row.Status, /CrashLoopBackOff|Error/);
    assert.equal(row.Ready, `0/${want.spec.containers.length}`);
    assert.ok(Math.abs(Number(row.Restarts) - cs.restartCount) <= 1, `Restarts ${row.Restarts} vs ${cs.restartCount}`);
    assert.ok(row._problem, "the crashed row is marked as a problem");
    await app.filter("");
  });

  it("CPU and Memory fill in from metrics-server, and ages tick", T, async () => {
    const { app } = s;
    await app.filter("web-");
    const row = await app.waitFor(
      async () =>
        (await tableData(app)).rows.find((r) => r.Namespace === "demo" && r.CPU && r.CPU !== "—" && r.Memory !== "—"),
      { timeout: 90_000, interval: 1000, message: "CPU/Memory on a demo/web pod" },
    );
    console.log(`web: CPU ${row.CPU}, Memory ${row.Memory}`);
    assert.match(row.CPU, /\d/);
    assert.match(row.Memory, /\d/);
    // The age changes as time passes, without a refresh. The pod may already
    // be past a minute (an earlier test waited long), where it reads "1m"
    // until "2m": wait up to 75 s for the change.
    await app.filter(dep);
    const age = async () => (await tableData(app)).rows.find((r) => r.Namespace === ns)?.Age;
    const first = await app.waitFor(age, { message: "the age of our pod" });
    const second = await app.waitFor(
      async () => {
        const a = await age();
        return a && a !== first ? a : null;
      },
      { timeout: 75_000, interval: 1000, message: `the age to change from ${first}` },
    );
    console.log(`age: ${first} -> ${second}`);
  });

  it("a row click opens the pod panel with logs, terminal and forward", T, async () => {
    const { app } = s;
    const [pod] = podNames(ns, `app=${dep}`);
    await app.openDetail("Pods", ns, pod);
    const buttons = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="detail-panel"] button'), (b) => b.textContent.trim())`,
    );
    for (const b of ["Logs", "Open terminal"]) assert.ok(buttons.includes(b), `"${b}" in the pod panel: ${buttons}`);
    // The details load after the panel opens.
    await app.waitFor(
      async () => {
        const text = await app.js(`return document.querySelector('[data-testid="detail-panel"]').innerText`);
        return ["Running", ns, "Containers"].every((w) => text.includes(w));
      },
      { message: "phase, namespace and containers in the pod panel" },
    );
  });

  it("filter and header sorting work", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await app.filter("demo");
    await app.waitFor(async () => {
      const { rows } = await tableData(app);
      return rows.length > 0 && rows.every((r) => Object.values(r).join(" ").includes("demo"));
    }, { message: "only rows matching demo" });
    await app.filter("");
    const header = await app.find(By.xpath("//*[@data-testid='resource-table']//*[@role='columnheader'][normalize-space()='Name' or starts-with(normalize-space(),'Name ')]"));
    const names = async () => (await tableData(app)).rows.map((r) => r.Name);
    for (const dir of ["ascending", "descending"]) {
      for (let i = 0; i < 3 && (await header.getAttribute("aria-sort")) !== dir; i++) await header.click();
      assert.equal(await header.getAttribute("aria-sort"), dir);
      const got = await names();
      const sorted = [...got].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (dir === "descending") sorted.reverse();
      assert.deepEqual(got, sorted, `Name ${dir}`);
      await app.shot(`sorted-${dir}`);
    }
    // Back to no sort on Name.
    for (let i = 0; i < 3 && (await header.getAttribute("aria-sort")) !== "none"; i++) await header.click();
  });

  it("kubectl run, delete and scale update rows live, keeping scroll and selection", T, async () => {
    const { app } = s;
    // A small window, so the all-namespaces Pods table scrolls.
    await resizeWindow(app, 1100, 560);
    await app.nav("Pods");
    await app.filter("");
    await waitLive(app);
    // Select a row in the middle, and scroll a little.
    const scroller = await app.find(By.css('[data-testid="resource-table"] .scroller'));
    const max = await app.js("return arguments[0].scrollHeight - arguments[0].clientHeight", scroller);
    assert.ok(max > 0, "the Pods table scrolls in a small window");
    await app.js("arguments[0].scrollTop = Math.min(arguments[1], 120)", scroller, max);
    await sleep(300);
    const { rows } = await tableData(app);
    const pick = rows[Math.floor(rows.length / 2)];
    await (await app.find(app.row(pick.Name, pick.Namespace))).click();
    await app.waitFor(async () => (await tableData(app)).rows.some((r) => r._selected && r.Name === pick.Name), {
      message: "the clicked row to be selected",
    });
    const top = await scrollTop(app);
    console.log(`selected ${pick.Namespace}/${pick.Name}, scrollTop ${top}`);

    // Changes in our namespace while the user looks at another row.
    kubectl(["-n", ns, "run", "qa-area1-run", "--image=busybox:1.36", "--image-pull-policy=IfNotPresent", "--", "sleep", "3600"]);
    kubectl(["-n", ns, "scale", `deploy/${dep}`, "--replicas=3"]);
    const [old] = podNames(ns, `app=${dep}`);
    kubectl(["-n", ns, "delete", "pod", old, "--wait=false"]);
    await sleep(5000);
    assert.equal(await scrollTop(app), top, "scroll position kept");
    assert.ok((await tableData(app)).rows.some((r) => r._selected && r.Name === pick.Name), "selection kept");
    const panel = await app.js(`return document.querySelector('[data-testid="detail-panel"] .title')?.textContent ?? ""`);
    assert.ok(panel.includes(`${pick.Namespace}/${pick.Name}`), `the panel still shows ${pick.Name}: ${panel}`);
    await app.shot("scroll-and-selection-kept");

    // The rows themselves (filtered to our namespace).
    await app.filter(ns);
    await app.waitFor(
      async () => {
        const mine = (await tableData(app)).rows.filter((r) => r.Namespace === ns);
        const deps = mine.filter((r) => r.Name.startsWith(`${dep}-`));
        return (
          mine.some((r) => r.Name === "qa-area1-run") && deps.length === 3 && !deps.some((r) => r.Name === old)
        );
      },
      { timeout: 90_000, message: "qa-area1-run, 3 replicas and no deleted pod" },
    );
    await resizeWindow(app, 1600, 1000);
  });

  it("the namespace control narrows the watch", T, async () => {
    const { app } = s;
    await app.filter("");
    await pickNamespaces(app, [ns]);
    await waitLive(app);
    await app.waitFor(async () => {
      const { rows } = await tableData(app);
      return rows.length === 4 && rows.every((r) => r.Namespace === ns);
    }, { message: `only the 4 pods of ${ns}` });
    await app.shot("one-namespace");
    await pickNamespaces(app, []);
    await app.waitFor(async () => new Set((await tableData(app)).rows.map((r) => r.Namespace)).size > 1, {
      message: "pods of several namespaces again",
    });
  });

  it("Nodes show CPU and memory as used / capacity", T, async () => {
    const { app } = s;
    await app.nav("Nodes");
    await waitLive(app);
    const want = kubectl(["get", "nodes", "-o", "jsonpath={.items[*].metadata.name}"]).split(/\s+/).sort();
    const rows = await app.waitFor(
      async () => {
        const r = (await tableData(app)).rows;
        return r.length === want.length && r.every((n) => n.CPU.includes("/") && n.Memory.includes("/")) ? r : null;
      },
      { timeout: 90_000, interval: 1000, message: "both nodes with CPU and memory" },
    );
    console.log(JSON.stringify(rows));
    assert.deepEqual(rows.map((r) => r.Name).sort(), want);
    for (const r of rows) {
      assert.equal(r.Ready, "True");
      assert.match(r.CPU, /^\S+ \/ \S+$/);
      assert.match(r.Memory, /^\S+ \/ \S+$/);
    }
  });

  it("Namespaces shows a namespace created and deleted with kubectl", T, async () => {
    const { app } = s;
    await app.nav("Namespaces");
    await waitLive(app);
    extraNs = `qa-area1-ns-${Date.now().toString(36)}`;
    await app.filter(extraNs);
    kubectl(["create", "namespace", extraNs]);
    await app.waitFor(async () => (await tableData(app)).rows.some((r) => r.Name === extraNs && r.Status === "Active"), {
      message: `${extraNs} Active`,
    });
    await app.shot("namespace-created");
    kubectl(["delete", "namespace", extraNs, "--wait=false"]);
    await app.waitFor(
      async () => {
        const r = (await tableData(app)).rows.find((r) => r.Name === extraNs);
        return !r || r.Status === "Terminating";
      },
      { timeout: 60_000, message: `${extraNs} Terminating or gone` },
    );
    await app.waitFor(async () => !(await tableData(app)).rows.some((r) => r.Name === extraNs), {
      timeout: 90_000,
      message: `${extraNs} gone`,
    });
    extraNs = undefined;
  });
});
