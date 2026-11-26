// Pod panel follow-ups (#513), at 1280x800 in the dark and the light theme:
// - a pod whose image cannot be pulled has no usage: Usage is one line
//   ("No usage data yet"), with why in its tooltip
// - its long pull-error events wrap inside the panel (no horizontal
//   scroll), folded to a few lines with "Show all" / "Show less"
// - the palette's "Describe" opens the panel of the focused row, and "Copy
//   kubectl describe" puts the describe text on the clipboard (WebKitGTK
//   only lets a page write it during the click: the text comes from the
//   backend after it)
// - #525: a container with an envFrom ConfigMap (3 keys) and 2 env
//   variables: "Environment (2 + 1 source)" until the list is opened,
//   then "Environment (5)", as many as the list shows
//
// Its pod lives in a temporary namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { readSystemClipboard } from "../lib/clipboard.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { closePanel, scrollPanelTo, setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 300_000 };
const PANEL = '[data-testid="detail-panel"]';

const YAML = `
apiVersion: v1
kind: Pod
metadata:
  name: pull
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: registry.invalid/inventory-api:1.2.3
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data: { A: "1", B: "2", C: "3" }
---
apiVersion: v1
kind: Pod
metadata:
  name: envy
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
      envFrom: [{ configMapRef: { name: app-config } }]
      env:
        - { name: MODE, value: production }
        - { name: LEVEL, value: debug }
`;

const frame = (app) =>
  app.driver.executeAsyncScript(
    "const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(() => done()))",
  );

async function shotBoth(app, name) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await frame(app);
    await app.shot(`${name}-${theme}`);
  }
  await setTheme(app, null);
}

/** The Usage section: its empty line, tooltip and height. */
const usage = (app) =>
  app.js(`
    const u = document.querySelector('${PANEL} [data-testid="usage-charts"]');
    if (!u) return null;
    const e = u.querySelector('[data-testid="usage-empty"]');
    const h = u.querySelector('h3');
    const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    return {
      empty: e?.textContent.trim() ?? "", title: e?.getAttribute("title") ?? "",
      note: u.querySelector('[data-testid="usage-note"]')?.textContent.trim() ?? "",
      height: u.getBoundingClientRect().height, sameLine: e && h ? Math.abs(mid(e) - mid(h)) < 4 : false,
      text: u.innerText,
    };`);

/** The events table: whether it fits, and its messages. */
const events = (app) =>
  app.js(`
    const t = document.querySelector('${PANEL} table.events');
    if (!t) return null;
    const sc = t.parentElement, panel = document.querySelector('${PANEL}');
    const pr = panel.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return {
      fits: sc.scrollWidth <= sc.clientWidth + 1 && tr.right <= pr.right + 1,
      scrollWidth: sc.scrollWidth, clientWidth: sc.clientWidth,
      messages: Array.from(t.querySelectorAll('[data-testid="event-message"]'), (m) => ({
        text: m.textContent.trim(), height: Math.round(m.getBoundingClientRect().height),
        cut: m.scrollWidth > m.clientWidth + 1,
        title: m.getAttribute("title") ?? "",
      })),
      buttons: Array.from(t.querySelectorAll('button.more'), (b) => b.textContent.trim()),
    };`);

const options = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="command-palette"] [role="option"]'), (o) => ({
    label: o.querySelector('.label')?.textContent.trim() ?? "", detail: o.querySelector('.detail')?.textContent.trim() ?? "" }));`);

/** Give the table row `name` the keyboard focus. */
async function focusRow(app, name) {
  await app.filter(name);
  await app.find(app.row(name));
  await app.js(`document.querySelector('[role="grid"]').focus()`);
  await app.driver.actions().sendKeys(Key.ARROW_DOWN).perform();
}

/** Ctrl+K, type `query`, click the option labelled `label`. */
async function pick(app, query, label) {
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys("k").keyUp(Key.CONTROL).perform();
  const dialog = await app.find(byTestId("command-palette"));
  await (await dialog.findElement(By.css('input[role="combobox"]'))).sendKeys(query);
  const o = await app.waitFor(
    async () => {
      const list = await options(app);
      return list.some((x) => x.label === label) ? list : null;
    },
    { message: `palette option "${label}"` },
  );
  console.log(`palette "${query}": ${JSON.stringify(o.slice(0, 6))}`);
  await app.shot(`palette-${label.toLowerCase().replace(/\W+/g, "-")}`);
  const el = await app.find(
    By.xpath(`//*[@data-testid='command-palette']//*[@role='option'][.//*[contains(@class,'label')][normalize-space()='${label}']]`),
  );
  await el.click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("command-palette"))).length === 0, {
    message: "the palette to close",
  });
}

let ns;

describe("pod panel follow-ups (#513)", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-podpanel", YAML);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("pod-panel");

  it("no usage: one line; long events wrap and fold", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Pods");
    await pickNamespaces(app, [ns]);
    await app.openDetail("Pods", ns, "pull");

    const u = await app.waitFor(
      async () => {
        const x = await usage(app);
        return x?.empty ? x : null;
      },
      { timeout: 60_000, interval: 1000, message: "the empty Usage line" },
    );
    console.log(`usage: ${JSON.stringify(u)}`);
    assert.equal(u.empty, "No usage data yet");
    assert.ok(u.sameLine, "the text is on the heading's line");
    assert.ok(u.height < 48, `Usage is one line (${u.height}px)`);
    assert.match(u.title, /metrics-server has no sample for this pod/);
    assert.equal(u.note, "", "the Prometheus search is in the tooltip, not on the panel");

    // The pull error's events are long; wait until one is folded.
    const e = await app.waitFor(
      async () => {
        const x = await events(app);
        return x?.buttons.includes("Show all") ? x : null;
      },
      { timeout: 120_000, interval: 2000, message: "a folded pull-error event" },
    );
    console.log(`events: ${JSON.stringify(e, null, 2)}`);
    assert.ok(e.fits, `the events table fits the panel (${e.scrollWidth} > ${e.clientWidth})`);
    assert.ok(e.messages.every((m) => !m.cut), "no message is cut at the side");
    await scrollPanelTo(app, "table.events");
    await shotBoth(app, "events-folded");

    const folded = e.messages.find((m) => m.title);
    await app.js(`document.querySelector('${PANEL} table.events button.more').click()`);
    const open = await app.waitFor(
      async () => {
        const x = await events(app);
        return x?.buttons.includes("Show less") ? x : null;
      },
      { message: "Show less" },
    );
    const whole = open.messages.find((m) => m.text === folded.text);
    console.log(`folded ${folded.height}px, open ${whole.height}px`);
    assert.ok(whole.height > folded.height, "Show all shows the whole message");
    assert.ok(open.fits, "still within the panel");
    await scrollPanelTo(app, "table.events");
    await shotBoth(app, "events-open");

    // Folded again; the panel's top, with the one-line Usage.
    await app.js(`document.querySelector('${PANEL} table.events button.more').click()`);
    await app.js(`document.querySelector('${PANEL}').scrollTop = 0`);
    await shotBoth(app, "usage-one-line");
  });

  it("the palette's Describe and Copy kubectl describe", T, async () => {
    const { app } = s;
    await closePanel(app);
    await focusRow(app, "pull");
    await pick(app, "describe", "Describe");
    await waitPanelTitle(app, `${ns}/pull`);
    await shotBoth(app, "describe-panel");

    // Which clipboard call the page made: write(ClipboardItem) or writeText.
    await app.js(`
      window.__qaCalls = [];
      const c = navigator.clipboard;
      if (c?.write) { const w = c.write.bind(c); c.write = (i) => { window.__qaCalls.push("write"); return w(i); }; }
      if (c?.writeText) { const w = c.writeText.bind(c); c.writeText = (t) => { window.__qaCalls.push("writeText"); return w(t); }; }`);
    await focusRow(app, "pull");
    await pick(app, "kubectl describe", "Copy kubectl describe");
    const notice = await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="action-notice"]')?.innerText.trim() || null`),
      { timeout: 20_000, message: "the copy notice" },
    );
    console.log(`notice: ${notice}; calls: ${JSON.stringify(await app.js("return window.__qaCalls"))}`);
    await app.shot("copy-describe-notice");
    assert.match(notice, /Copied the describe of Pod pull/);
    const text = await app.waitFor(
      () => {
        const t = readSystemClipboard();
        return t && t.includes("Name:") ? t : null;
      },
      { timeout: 10_000, message: `the describe text on the clipboard (${JSON.stringify(readSystemClipboard())})` },
    );
    console.log(`clipboard:\n${text}`);
    assert.match(text, /^Name:\s+pull$/m);
    assert.match(text, new RegExp(`^Namespace:\\s+${ns}$`, "m"));
    assert.match(text, /registry\.invalid\/inventory-api:1\.2\.3/);
  });

  it("Environment (N) counts the variables of an envFrom source (#525)", T, async () => {
    const { app } = s;
    await closePanel(app);
    await app.openDetail("Pods", ns, "envy");
    const summary = () =>
      app.js(`const s = Array.from(document.querySelectorAll('${PANEL} section[aria-label="Container app"] summary'))
        .find((x) => x.textContent.trim().startsWith("Environment"));
        return s ? { text: s.textContent.trim(), rows: s.parentElement.querySelectorAll('[data-testid="env-row"]').length } : null;`);
    const before = await app.waitFor(summary, { message: "the Environment summary" });
    console.log(`before: ${JSON.stringify(before)}`);
    assert.equal(before.text, "Environment (2 + 1 source)");
    await app.js(`Array.from(document.querySelectorAll('${PANEL} section[aria-label="Container app"] summary'))
      .find((x) => x.textContent.trim().startsWith("Environment")).click()`);
    const after = await app.waitFor(
      async () => {
        const x = await summary();
        return x?.rows >= 5 && x.text === "Environment (5)" ? x : null;
      },
      { timeout: 20_000, message: `Environment (5) with 5 rows (${JSON.stringify(await summary())})` },
    );
    console.log(`after: ${JSON.stringify(after)}`);
    assert.equal(after.rows, 5);
    await scrollPanelTo(app, 'section[aria-label="Container app"]');
    await shotBoth(app, "env-count");
  });
});
