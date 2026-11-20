// The Pods table's Containers column (#379): one state square per container
// and init container. Off by default; turned on in the column chooser, it
// shows a multi-container pod with an init container that completed, a ready
// app, a container that runs but is not ready, and a crash-looping sidecar:
// each square with its shape, colour and tooltip, the cell with a text
// alternative. Then the shared demo namespace (`demo/multi`, `demo/crashed`),
// in light and dark.
//
// Objects it creates live in a temporary qa-squares-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 240_000 };
const POD = "qa-squares";

const podYaml = `
apiVersion: v1
kind: Pod
metadata:
  name: ${POD}
spec:
  terminationGracePeriodSeconds: 0
  initContainers:
    - name: setup
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo ready"]
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 3600"]
    - name: warming
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 3600"]
      readinessProbe:
        exec: { command: ["false"] }
        periodSeconds: 2
    - name: sidecar
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo 'sidecar: cannot reach the mesh' >&2; exit 1"]
`;

const chooserButton = By.xpath("//button[starts-with(normalize-space(), 'Columns')]");
const choice = (label) => By.xpath(`//*[@role='dialog'][@aria-label='Columns']//label[normalize-space()='${label}']//input`);
const SCROLLER = '[data-testid="resource-table"] .scroller';

/** Every row's squares: name -> [{ title, look }], in order. */
const squares = (app) =>
  app.js(`
    const out = {};
    for (const r of document.querySelectorAll('[data-testid="resource-row"]')) {
      const name = r.querySelectorAll('[role="gridcell"]')[1]?.textContent.trim();
      out[name] = Array.from(r.querySelectorAll('[data-testid="container-square"]'), (s) => ({
        title: s.getAttribute("title"),
        look: s.dataset.look,
        hidden: s.getAttribute("aria-hidden"),
        colour: getComputedStyle(s).color,
      }));
    }
    return out;`);

describe("pods: the Containers column", { timeout: 15 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-squares", podYaml);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("container-squares");

  it("is off by default; turned on, it shows one square per container", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await app.nav("Pods");
    await waitLive(app);
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 1, { message: "the pod of the namespace" });
    assert.ok(!(await tableData(app)).headers.includes("Containers"), "off by default");
    await (await app.find(chooserButton)).click();
    const box = await app.find(choice("Containers"));
    assert.equal(await box.isSelected(), false, "listed unchecked");
    await box.click();
    await (await app.find(chooserButton)).click();
    await app.waitFor(async () => (await tableData(app)).headers.includes("Containers"), { message: "the column" });
  });

  it("init container, ready app, not-ready container and crash-looping sidecar", T, async () => {
    const { app } = s;
    // The sidecar dies at once: it is in CrashLoopBackOff most of the time.
    await app.waitFor(
      async () => {
        const sq = (await squares(app))[POD] ?? [];
        return (
          sq.length === 4 &&
          sq[0].look === "done" &&
          sq[1].look === "ok" &&
          sq[2].look === "warn" &&
          sq[3].title.includes("CrashLoopBackOff")
        );
      },
      { timeout: 180_000, message: "setup done, app ready, warming not ready, sidecar crash-looping" },
    );
    await app.js(`document.querySelector('${SCROLLER}').scrollLeft = 1e6`);
    await app.shot("pod-dark");
    const sq = (await squares(app))[POD];
    assert.deepEqual(
      sq.map((x) => x.title),
      [
        "init container setup: completed",
        "app: running, ready",
        "warming: running, not ready",
        "sidecar: waiting, CrashLoopBackOff",
      ],
    );
    assert.equal(sq[3].look, "bad");
    assert.ok(sq.every((x) => x.hidden === "true"), "the squares are hidden from screen readers");
    // The cell's text (for screen readers) names every container.
    const cell = (await tableData(app)).rows[0].Containers;
    assert.match(cell, /^4 containers: init container setup: completed; app: running, ready;/);
    // Four looks, four colours: green, amber, red, grey.
    assert.equal(new Set(sq.map((x) => x.colour)).size, 4);
    await setTheme(app, "light");
    await app.shot("pod-light");
  });

  it("the demo namespace: demo/multi and demo/crashed", T, async (t) => {
    const { app } = s;
    await app.filter("demo");
    const ready = await app
      .waitFor(
        async () => {
          const sq = await squares(app);
          return sq.multi?.length === 3 && sq.crashed?.length === 1;
        },
        { timeout: 30_000, message: "demo/multi and demo/crashed" },
      )
      .then(() => true, () => false);
    if (!ready) {
      t.skip("no demo namespace on this cluster");
      return;
    }
    const sq = await squares(app);
    assert.deepEqual(
      sq.multi.map((x) => x.title),
      ["init container init-setup: completed", "app: running, ready", "sidecar: running, ready"],
    );
    // demo/crashed is red while it waits in CrashLoopBackOff, between runs.
    await app.waitFor(async () => (await squares(app)).crashed?.[0]?.look === "bad", {
      timeout: 120_000,
      message: "demo/crashed in CrashLoopBackOff",
    });
    await app.js(`document.querySelector('${SCROLLER}').scrollLeft = 1e6`);
    await app.shot("demo-light");
    await setTheme(app, "dark");
    await app.shot("demo-dark");
  });

  it("sorting by Containers puts the broken pods first", T, async () => {
    const { app } = s;
    const head = await app.find(By.xpath("//*[@role='columnheader'][normalize-space()='Containers' or starts-with(normalize-space(), 'Containers')]"));
    await head.click();
    await head.click();
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[role="columnheader"][aria-sort="descending"]')?.textContent ?? ""`)).includes("Containers"),
      { message: "sorted descending" },
    );
    const sq = await squares(app);
    const first = Object.values(sq)[0] ?? [];
    assert.ok(first.some((x) => x.look === "bad"), `first row has a broken container: ${JSON.stringify(first)}`);
    await app.js(`document.querySelector('${SCROLLER}').scrollLeft = 1e6`);
    await app.shot("sorted-dark");
  });

  it("an empty table keeps the column's header", T, async () => {
    const { app } = s;
    await app.filter("nothing-matches-this");
    await app.waitFor(async () => (await tableData(app)).rows.length === 0, { message: "an empty table" });
    assert.ok((await tableData(app)).headers.includes("Containers"));
    await app.shot("empty-dark");
  });
});
