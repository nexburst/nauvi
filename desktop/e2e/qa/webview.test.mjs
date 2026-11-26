// #205: the webview itself, in WebKitGTK.
// - the CSP of tauri.conf.json is in force (eval is blocked) and the parts
//   that inject styles still render: CodeMirror (the YAML editor), xterm
//   (a local terminal) and the usage charts; no CSP violation is reported
// - right-click keeps the engine's menu only in text fields, the YAML
//   editor and the terminal; a row still opens the app's menu
// - F5, Ctrl+R and Ctrl+Shift+R run Refresh: the page is not reloaded
// - a real page load (location.reload) stops what the old page started
//   (the local shell's process) and the app comes back up, on its context

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, podNames, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { appPid } from "../lib/dock.mjs";
import { clickX11, cannotCloseLikeUser } from "../lib/window.mjs";
import { closeNamespacePicker, pickNamespaces } from "../lib/table.mjs";
import { contextMenu, closeMenu, editor, editorValue } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURE = `
apiVersion: v1
kind: ConfigMap
metadata: { name: qa205-cm }
data:
  greeting: hello
`;
let ns;

/** Collect CSP violations from now on (until the next page load). */
const watchViolations = (app) =>
  app.js(`
    window.__qaViolations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__qaViolations.push(e.violatedDirective + " " + (e.blockedURI || "inline") + " " + (e.sourceFile || "")));`);
const violations = (app) => app.js("return window.__qaViolations ?? []");

/** Right-click `el`; whether the engine's menu would open (the event was not prevented). */
async function engineMenuOn(app, el) {
  await app.js(`
    window.__qaMenu = null;
    // Runs after the app's handlers; then keeps the native popup away, so
    // it cannot grab the input of the next steps.
    window.addEventListener("contextmenu", (e) => {
      window.__qaMenu = !e.defaultPrevented;
      e.preventDefault();
    }, { once: true });`);
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", el);
  await app.driver.actions().contextClick(el).perform();
  await app.waitFor(() => app.js("return window.__qaMenu !== null"), { message: "the contextmenu event" });
  return app.js("return window.__qaMenu");
}

/** Open a kind showing only `namespace`, filtered to `text`. */
async function showKind(app, label, namespace, text) {
  await app.nav(label);
  await pickNamespaces(app, [namespace]);
  await closeNamespacePicker(app);
  await app.filter(text);
}

const markPage = (app) => app.js("window.__qa205 = 'same page'");
const samePage = (app) => app.js("return window.__qa205 === 'same page'");

async function openYaml(app) {
  await showKind(app, "Config Maps", ns, "qa205-cm");
  await app.clickRow("qa205-cm", ns);
  const panel = await app.find(By.css('[data-testid="detail-panel"]'));
  await (await panel.findElement(By.xpath(`.//button[@role='tab'][normalize-space()='YAML']`))).click();
  const el = await editor(app, "yaml-editor");
  await app.waitFor(async () => (await editorValue(app, el)).includes("greeting: hello"), { message: "the YAML" });
  return el;
}

function alive(pid) {
  return existsSync(`/proc/${pid}`);
}

describe("#205: webview menu, reload keys, page reload and CSP", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa205", FIXTURE);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("webview", { env: { SHELL: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh" } });

  it("runs under the CSP: eval is blocked", T, async () => {
    const { app } = s;
    await waitLive(app);
    const evalResult = await app.js(`try { return "allowed: " + (0, eval)("1 + 1"); } catch (e) { return e.name; }`);
    console.log(`eval under the CSP: ${evalResult}`);
    assert.equal(evalResult, "EvalError", "the CSP blocks eval");
    // From here on, any violation is the app's (the eval above is ours).
    await watchViolations(app);
  });

  it("CodeMirror renders and edits under the CSP (light and dark)", T, async () => {
    const { app } = s;
    const el = await openYaml(app);
    // CodeMirror's own styles are injected at run time (style-mod).
    const style = await app.js(
      `const ed = arguments[0].querySelector(".cm-editor") ?? arguments[0];
       const gutter = ed.querySelector(".cm-gutters");
       return { display: getComputedStyle(ed).display, gutter: gutter ? getComputedStyle(gutter).display : null,
                lines: ed.querySelectorAll(".cm-line").length };`,
      el,
    );
    console.log(`editor: ${JSON.stringify(style)}`);
    assert.equal(style.display, "flex", "CodeMirror's injected base theme applies");
    assert.ok(style.lines > 3, "lines rendered");
    await setTheme(app, "dark");
    await app.shot("yaml-editor-dark");
    await setTheme(app, "light");
    await app.shot("yaml-editor-light");
    await setTheme(app, null);
  });

  it("xterm renders under the CSP", T, async () => {
    const { app } = s;
    await app.palette("local term", "New local terminal");
    const term = terminal(app);
    await term.waitFor(`kubectl uses context ${CONTEXT}`);
    await term.waitForPrompt();
    assert.equal(await term.run("echo csp-ok"), "csp-ok");
    const style = await app.js(`
      const x = document.querySelector('[data-testid="terminal"] .xterm');
      const ta = x.querySelector(".xterm-helper-textarea");
      const rows = x.querySelector(".xterm-rows");
      return { textarea: getComputedStyle(ta).position, rowsHeight: rows.getBoundingClientRect().height,
               color: getComputedStyle(rows).color };`);
    console.log(`terminal: ${JSON.stringify(style)}`);
    assert.equal(style.textarea, "absolute", "xterm.css applies");
    assert.ok(style.rowsHeight > 50, "rows laid out");
    await app.shot("terminal");
  });

  it("F5, Ctrl+R and Ctrl+Shift+R run Refresh, not a page reload", T, async () => {
    const { app } = s;
    await app.nav("Config Maps");
    await app.find(app.row("qa205-cm", ns));
    await markPage(app);
    const body = await app.find(By.css("[role='grid']"));
    await app.js("arguments[0].focus()", body);
    for (const keys of [[Key.F5], [Key.CONTROL, "r"], [Key.CONTROL, Key.SHIFT, "r"]]) {
      const a = app.driver.actions();
      for (const k of keys.slice(0, -1)) a.keyDown(k);
      a.sendKeys(keys[keys.length - 1]);
      for (const k of keys.slice(0, -1).reverse()) a.keyUp(k);
      await a.perform();
      await sleep(1500);
      assert.equal(await samePage(app), true, `${keys.length} key(s): no page reload`);
    }
    // The table came back after the refreshes.
    await app.find(app.row("qa205-cm", ns));
    await waitLive(app);
  });

  it("the usage charts render under the CSP", T, async () => {
    const { app } = s;
    const pod = podNames("demo", "app=web")[0];
    assert.ok(pod, "a demo/web pod");
    await showKind(app, "Pods", "demo", pod);
    await app.clickRow(pod, "demo");
    const chart = await app.waitFor(
      () =>
        app.js(`
          const c = document.querySelector('[data-testid="detail-panel"] [data-testid="usage-charts"]');
          if (!c) return null;
          c.scrollIntoView({ block: "center" });
          const svg = c.querySelector("svg");
          return { text: c.innerText.slice(0, 200), svg: svg ? svg.getBoundingClientRect().width : 0 };`),
      { timeout: 60_000, message: "the usage charts" },
    );
    console.log(`usage: ${JSON.stringify(chart)}`);
    await sleep(1000);
    await setTheme(app, "dark");
    await app.shot("usage-dark");
    await setTheme(app, null);
    const v = await violations(app);
    console.log(`CSP violations: ${JSON.stringify(v)}`);
    assert.deepEqual(v, [], "no CSP violations");
  });

  it("a real page load stops the old page's shell and the app comes back", T, async () => {
    const { app } = s;
    const term = terminal(app);
    const pid = Number(await term.run("echo $$"));
    assert.ok(pid > 0 && alive(pid), `shell pid ${pid}`);
    await app.js("location.reload()");
    await app.waitFor(async () => !(await samePage(app).catch(() => true)), { message: "the page to reload" });
    await waitLive(app);
    await app.waitFor(() => !alive(pid), { timeout: 15_000, message: `shell ${pid} to stop` });
    const tabs = await app.js(`return document.querySelectorAll('[data-testid="dock"] [role="tab"]').length`);
    assert.equal(tabs, 0, "no dock tabs after the reload");
    // The fresh session works: a table loads and a new shell starts.
    await showKind(app, "Config Maps", ns, "qa205-cm");
    await app.find(app.row("qa205-cm", ns));
    await watchViolations(app);
    await app.palette("local term", "New local terminal");
    await terminal(app).waitForPrompt();
    assert.equal(await terminal(app).run("echo after-reload"), "after-reload");
    assert.deepEqual(await violations(app), []);
    await app.shot("after-reload");
  });

  // Last: after WebDriver's right clicks, keys typed into a terminal lost
  // their Shift in WebKitGTK (a driver quirk, not seen with a real mouse).
  it("right-click: the engine's menu only in text fields, the editor and the terminal", T, async () => {
    const { app } = s;
    const x = await app.find(By.css('[data-testid="terminal"] .xterm'));
    assert.equal(await engineMenuOn(app, x), true, "terminal keeps it");
    const el = await openYaml(app);
    assert.equal(await engineMenuOn(app, await el.findElement(By.css(".cm-content"))), true, "editor keeps it");
    const panelTitle = await app.find(By.css('[data-testid="detail-panel"] .title'));
    assert.equal(await engineMenuOn(app, panelTitle), false, "panel title suppresses it");
    const refresh = await app.find(By.xpath("//button[normalize-space()='Refresh']"));
    assert.equal(await engineMenuOn(app, refresh), false, "header suppresses it");
    assert.equal(await engineMenuOn(app, await app.find(By.css("nav h4"))), false, "sidebar suppresses it");
    assert.equal(await engineMenuOn(app, await app.find(By.css("#table-filter"))), true, "filter keeps it");
    assert.ok(await app.find(By.css('[data-testid="detail-panel"] .title')), "the panel is still open");
    // A row still opens the app's own menu.
    const menu = await contextMenu(app, "qa205-cm", ns);
    console.log(`row menu: ${JSON.stringify(menu)}`);
    await app.shot("row-menu");
    await closeMenu(app);
  });

  // In the first run the panel closed after WebDriver right-clicked the
  // centre of the sidebar, which is the Config Maps button: its synthesized
  // right click fired `click` there. A real (XTEST) right click must not.
  it("a real right click on a sidebar item does not open it", { ...T, skip: cannotCloseLikeUser() }, async () => {
    const { app } = s;
    await app.find(By.css('[data-testid="detail-panel"] .title'));
    const rect = await app.js(`
      window.__qaClicks = [];
      window.addEventListener("click", (e) => window.__qaClicks.push(e.button), true);
      const b = Array.from(document.querySelectorAll("nav button")).find((x) => x.textContent.trim() === "Config Maps");
      b.scrollIntoView({ block: "center" });
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    assert.ok(clickX11(appPid(app.profile.home), rect.x, rect.y, 3), "an X11 window");
    await sleep(800);
    const clicks = await app.js("return window.__qaClicks");
    console.log(`clicks from a real right click: ${JSON.stringify(clicks)}`);
    assert.deepEqual(clicks, [], "no click event");
    assert.ok(await app.find(By.css('[data-testid="detail-panel"] .title')), "the panel is still open");
    await app.shot("after-real-right-click");
  });
});
