// Table columns (#547): the Image column of Pods and workloads (off by
// default; the first image, short, "+1" for a second container, every
// full reference with the digest it runs on hover), custom columns from a
// label, an annotation and a field path (a bad path says why; renamed,
// removed, kept over a restart; sorted and filtered), reordering by
// Alt+arrows and by dragging, Reset to default, the chooser's search and
// a header's right-click menu. At 1280x800, dark and light.
//
// No extra requests: with custom columns on, the table's watch is the only
// one, and over 25 s the page makes no more calls to the backend than the
// metrics poll it makes without them.
//
// Objects it creates live in a temporary qa-columns-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { xq } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };

const deployment = (name, version, sidecar) => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
        app.kubernetes.io/version: "${version}"
      annotations:
        qa.nauvi.dev/team: ${sidecar ? "blue" : "green"}
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 3600"]
${
  sidecar
    ? `        - name: sidecar
          image: nginx:1.27
          imagePullPolicy: IfNotPresent
`
    : ""
}`;

const DIALOG = "//*[@role='dialog'][@aria-label='Columns']";
const chooserButton = By.xpath("//button[starts-with(normalize-space(), 'Columns')]");
const choice = (label) => By.xpath(`${DIALOG}//label[normalize-space()=${xq(label)}]//input`);
const inDialog = (xpath) => By.xpath(`${DIALOG}${xpath}`);
const button = (label) => inDialog(`//button[normalize-space()=${xq(label)}]`);
const field = (label) => inDialog(`//label[starts-with(normalize-space(), ${xq(label)})]//*[self::input or self::select]`);

/** Find `locator`, scroll it into view (the chooser and the table scroll), click it. */
async function click(app, locator) {
  const el = await app.waitFor(async () => (await app.driver.findElements(locator))[0], { message: String(locator) });
  await app.js("arguments[0].scrollIntoView({ block: 'center', inline: 'center' })", el);
  await el.click();
}
const headers = async (app) => (await tableData(app)).headers.filter(Boolean);
const rowsByName = async (app) => Object.fromEntries((await tableData(app)).rows.map((r) => [r.Name, r]));

async function openChooser(app) {
  if ((await app.driver.findElements(By.xpath(DIALOG))).length === 0) await click(app, chooserButton);
  await app.find(By.xpath(DIALOG));
}
async function closeChooser(app) {
  if ((await app.driver.findElements(By.xpath(DIALOG))).length) await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  await app.waitFor(async () => (await app.driver.findElements(By.xpath(DIALOG))).length === 0, {
    message: "the chooser closed",
  });
}

/** Add a custom column through the chooser's form; returns the error shown, if any. */
async function addColumn(app, { name, from, value }) {
  await openChooser(app);
  await click(app, button("+ Add column…"));
  await app.setValue(await app.find(field("Name")), name);
  const select = await app.find(field("From"));
  await (await select.findElement(By.xpath(`./option[normalize-space()=${xq(from)}]`))).click();
  await app.setValue(await app.find(field(from === "Field path" ? "Path" : "Key")), value);
  await click(app, button("Add"));
  return app.js(`return document.getElementById("column-draft-error")?.textContent.trim() ?? ""`);
}

/** Commands the page sent to the backend since `startCounting`, by name. */
const startCounting = (app) =>
  app.js(`
    const w = window;
    w.__qaCalls = {};
    if (!w.__qaWrapped) {
      const inner = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd, ...rest) => {
        if (w.__qaCalls) w.__qaCalls[cmd] = (w.__qaCalls[cmd] ?? 0) + 1;
        return inner(cmd, ...rest);
      };
      w.__qaWrapped = true;
    }`);
const counted = (app) => app.js("return window.__qaCalls ?? {}");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("table columns", { timeout: 15 * 60_000 }, () => {
  let ns;
  let pods;
  before(() => {
    ns = tempNamespace("qa-columns", deployment("qa-col-duo", "2.5.0", true) + "---\n" + deployment("qa-col-solo", "1.0.0", false));
    kubectl(["-n", ns, "rollout", "status", "deploy/qa-col-duo", "--timeout=180s"]);
    kubectl(["-n", ns, "rollout", "status", "deploy/qa-col-solo", "--timeout=180s"]);
    pods = JSON.parse(kubectl(["-n", ns, "get", "pods", "-o", "json"])).items.map((p) => ({
      name: p.metadata.name,
      app: p.metadata.labels.app,
      ip: p.status.podIP,
      digests: (p.status.containerStatuses ?? []).map((c) => c.imageID.split("@")[1] ?? ""),
    }));
  });
  after(() => deleteNamespace(ns));
  const s = appSession("columns");

  async function showPods(app) {
    await app.nav("Pods");
    await waitLive(app);
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 2, { message: "the two pods of the namespace" });
  }

  it("the Image column is off by default; on, it shows the first image and +1, all references on hover", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await showPods(app);
    assert.ok(!(await headers(app)).includes("Image"), "off by default");
    await openChooser(app);
    assert.equal(await (await app.find(choice("Image"))).isSelected(), false);
    await app.shot("chooser-fresh-dark");
    await click(app, choice("Image"));
    await closeChooser(app);
    await app.waitFor(async () => (await headers(app)).includes("Image"), { message: "the Image column" });
    const rows = await rowsByName(app);
    const duo = pods.find((p) => p.app === "qa-col-duo");
    const solo = pods.find((p) => p.app === "qa-col-solo");
    assert.equal(rows[duo.name].Image, "busybox:1.36 +1");
    assert.equal(rows[solo.name].Image, "busybox:1.36");
    const title = await app.js(
      `const row = [...document.querySelectorAll('[data-testid="resource-row"]')].find((r) => r.textContent.includes(arguments[0]));
       const i = [...document.querySelectorAll('.head [role="columnheader"]')].findIndex((h) => h.textContent.trim().startsWith("Image"));
       return row.querySelectorAll('[role="gridcell"]')[i].getAttribute("title");`,
      duo.name,
    );
    const lines = title.split("\n");
    assert.equal(lines.length, 3, title);
    assert.equal(lines[0], "busybox:1.36 +1", title);
    assert.ok(lines[1].startsWith("docker.io/library/busybox:1.36"), title);
    assert.ok(lines[2].startsWith("docker.io/library/nginx:1.27"), title);
    if (duo.digests[0]) assert.ok(title.includes(duo.digests[0]) || title.includes(duo.digests[1]), `digest in ${title}`);
    await app.shot("image-column-dark");

    // Workloads have it too, off by default.
    await app.nav("Deployments");
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 2, { message: "the two deployments" });
    assert.ok(!(await headers(app)).includes("Image"));
    await openChooser(app);
    await click(app, choice("Image"));
    await closeChooser(app);
    await app.waitFor(async () => (await rowsByName(app))["qa-col-duo"]?.Image === "busybox:1.36 +1", {
      message: "the deployment's images",
    });
    await setTheme(app, "light");
    await app.shot("deployments-image-light");
    await setTheme(app, "dark");
  });

  it("custom columns from a label, an annotation and a field path; a bad path says why", T, async () => {
    const { app } = s;
    await showPods(app);
    const err = await addColumn(app, { name: "Pod IP", from: "Field path", value: "status.podIP" });
    assert.equal(err, "A field path starts with a dot, for example .status.podIP.");
    await app.shot("bad-path-dark");
    await setTheme(app, "light");
    await app.shot("bad-path-light");
    await setTheme(app, "dark");
    await app.setValue(await app.find(field("Path")), ".status.podIP");
    await click(app, button("Add"));
    assert.equal(await addColumn(app, { name: "Version", from: "Label", value: "app.kubernetes.io/version" }), "");
    assert.equal(await addColumn(app, { name: "Team", from: "Annotation", value: "qa.nauvi.dev/team" }), "");
    await app.shot("chooser-with-custom-dark");
    await closeChooser(app);
    await app.waitFor(
      async () => {
        const rows = await rowsByName(app);
        return pods.every((p) => rows[p.name]?.["Pod IP"] === p.ip);
      },
      { message: "the custom cells" },
    );
    const rows = await rowsByName(app);
    for (const p of pods) {
      assert.equal(rows[p.name].Version, p.app === "qa-col-duo" ? "2.5.0" : "1.0.0");
      assert.equal(rows[p.name].Team, p.app === "qa-col-duo" ? "blue" : "green");
    }
    // They are past the right edge at 1280 px: the table scrolls to them.
    await app.js(`document.querySelector('[data-testid="resource-table"] .scroller').scrollLeft = 1e6`);
    await app.shot("custom-columns-dark");
    await setTheme(app, "light");
    await app.shot("custom-columns-light");
    await setTheme(app, "dark");
  });

  it("they sort and filter; with them on, the page asks the backend for nothing more", T, async () => {
    const { app } = s;
    const versionHeader = By.xpath("//*[@role='columnheader'][starts-with(normalize-space(), 'Version')]");
    await click(app, versionHeader);
    await app.waitFor(async () => (await tableData(app)).rows[0]?.Version === "1.0.0", { message: "sorted by Version" });
    await click(app, versionHeader);
    await app.waitFor(async () => (await tableData(app)).rows[0]?.Version === "2.5.0", { message: "sorted descending" });
    await app.filter("2.5.0");
    await app.waitFor(async () => (await tableData(app)).rows.length === 1, { message: "the filter on Version" });
    await app.filter(ns);
    await app.waitFor(async () => (await tableData(app)).rows.length === 2, { message: "both rows again" });

    await startCounting(app);
    await sleep(25_000);
    const calls = await counted(app);
    // No other watch, list or object read for the custom cells: they come
    // with the rows of the one watch (the metrics poll goes on as before).
    const reads = Object.keys(calls).filter((c) => /watch|resource|list|detail|describe|get_/.test(c));
    assert.deepEqual(reads, [], `calls in 25 s: ${JSON.stringify(calls)}`);
  });

  it("columns move by Alt+arrows and by dragging; renamed, removed, kept over a restart", T, async () => {
    const { app } = s;
    await openChooser(app);
    const status = await app.find(choice("Status"));
    await app.js("arguments[0].focus()", status);
    await app.driver.actions().keyDown(Key.ALT).sendKeys(Key.ARROW_UP).sendKeys(Key.ARROW_UP).keyUp(Key.ALT).perform();
    await app.waitFor(async () => (await headers(app))[1] === "Status", { message: "Status moved second" });

    // Drag Node by its handle above Ready.
    const item = (label) => inDialog(`//li[.//label[normalize-space()=${xq(label)}]]`);
    const handle = await (await app.find(item("Node"))).findElement(By.css('[data-testid="column-handle"]'));
    const target = await app.find(item("Ready"));
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", target);
    const rect = await target.getRect();
    await app.driver
      .actions()
      .move({ origin: handle })
      .press()
      .move({ origin: target, x: 0, y: -Math.floor(rect.height / 2) + 2, duration: 200 })
      .release()
      .perform();
    await app.waitFor(
      async () => {
        const h = await headers(app);
        return h.indexOf("Node") >= 0 && h.indexOf("Node") < h.indexOf("Ready");
      },
      { message: "Node dragged before Ready" },
    );
    await app.shot("reordered-dark");

    // Rename Version.
    await click(app, inDialog("//button[@aria-label='Edit column Version']"));
    await app.setValue(await app.find(field("Name")), "App version");
    await click(app, button("Save"));
    // Remove Team.
    await click(app, inDialog("//button[@aria-label='Remove column Team']"));
    await closeChooser(app);
    await app.waitFor(async () => (await headers(app)).includes("App version"), { message: "the renamed column" });
    assert.ok(!(await headers(app)).includes("Team"));
    const before = await headers(app);

    await app.restart();
    await showPods(app);
    await app.waitFor(async () => (await headers(app)).join() === before.join(), {
      message: `the same columns after the restart: ${before.join(", ")}`,
    });
    const rows = await rowsByName(app);
    assert.ok(pods.every((p) => rows[p.name]["Pod IP"] === p.ip), "custom cells after the restart");
  });

  it("a header's right-click menu hides it or opens the chooser; the chooser can be searched", T, async () => {
    const { app } = s;
    const node = await app.find(By.xpath("//*[@role='columnheader'][normalize-space()='Node']"));
    await app.driver.actions().contextClick(node).perform();
    await app.find(By.xpath("//*[@role='menu']"));
    await app.shot("header-menu-dark");
    await click(app, By.xpath("//*[@role='menuitem'][normalize-space()='Hide this column']"));
    await app.waitFor(async () => !(await headers(app)).includes("Node"), { message: "Node hidden" });

    const name = await app.find(By.xpath("//*[@role='columnheader'][normalize-space()='Name']"));
    await app.driver.actions().contextClick(name).perform();
    await click(app, By.xpath("//*[@role='menuitem'][starts-with(normalize-space(), 'Columns')]"));
    const search = await app.find(inDialog("//input[@aria-label='Find a column']"));
    await app.setValue(search, "ip");
    await app.waitFor(
      async () =>
        (await app.js(`return document.querySelectorAll('[role="dialog"][aria-label="Columns"] input[type="checkbox"]').length`)) ===
        2,
      { message: "IP and Pod IP found" },
    );
    await app.shot("chooser-search-dark");
    await setTheme(app, "light");
    await app.shot("chooser-search-light");
    await setTheme(app, "dark");
    await app.setValue(search, "");

    await click(app, button("Reset to default"));
    await app.waitFor(async () => (await headers(app)).slice(0, 4).join() === "Name,Namespace,Ready,Status", {
      message: "the kind's own order back",
    });
    const h = await headers(app);
    assert.ok(h.includes("Node") && !h.includes("Image"), h.join());
    // Custom columns stay, at the end.
    assert.ok(h.includes("Pod IP") && h.includes("App version"), h.join());
    await app.shot("reset-dark");
    await closeChooser(app);
    // An empty table keeps its header.
    await app.filter("nothing-matches-this");
    await app.waitFor(async () => (await tableData(app)).rows.length === 0, { message: "an empty table" });
    await app.shot("empty-dark");
    await setTheme(app, "light");
    await app.shot("empty-light");
  });
});
