// Helper: restarting the app with the same config dir (App.restart, with
// the profile from lib/profile.mjs).
// Checks (#39): the view survives a restart and settings.json exists; a
// garbage settings.json gives the defaults and is kept as .corrupt.
// QA area 5 (#83, PR #70): the context, view, namespaces, sort, hidden
// columns, detail panel width and dock height all come back after a
// restart; a setting changed just before the window is closed (well under
// the 400 ms debounce) is still saved by the exit flush.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { aliasKubeconfig, appPid, dockHeight, dragDock, openPodLogs } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { namespaceChips, pickNamespaces } from "../lib/table.mjs";
import { waitTheme } from "../lib/theme.mjs";
import { cannotCloseLikeUser, selectContext, x11Windows } from "../lib/window.mjs";

const T = { timeout: 120_000 };
// The label only: a problem badge ("Pods 2") may follow it.
const activeKind = (app) => app.js(`return document.querySelector("nav button.active .label")?.textContent.trim() ?? ""`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WM_CLOSE = join(dirname(fileURLToPath(import.meta.url)), "../lib/wm-close.py");

/** The header cells of the table: label and aria-sort. */
const headers = (app) =>
  app.js(
    `return Array.from(document.querySelectorAll('[role="columnheader"]'), (h) => [h.textContent.trim(), h.getAttribute("aria-sort")]);`,
  );
const panelWidth = (app) =>
  app.js(`return Math.round(document.querySelector('[data-testid="detail-panel"]')?.getBoundingClientRect().width ?? 0)`);
const contextValue = (app) => app.js(`return document.querySelector('select[aria-label="Cluster context"]')?.value ?? ""`);

let kc;

describe("settings survive a restart", { timeout: 15 * 60_000 }, () => {
  after(() => kc?.remove());
  const s = appSession("persistence", () => {
    kc = aliasKubeconfig();
    return { kubeconfig: kc.path };
  });

  it("remembers the view across a restart", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Deployments");
    await app.waitFor(async () => (await activeKind(app)) === "Deployments", { message: "Deployments active" });
    await app.restart();
    await app.find(By.css("nav"));
    await app.waitFor(async () => (await activeKind(app)) === "Deployments", {
      timeout: 30_000,
      message: "Deployments active after the restart",
    });
    // The profile starts with "{}" (#485): check what the app wrote.
    assert.ok(existsSync(app.profile.settingsPath), `${app.profile.settingsPath} exists`);
    const written = app.profile.settings();
    assert.ok(Object.values(written?.contexts ?? {}).some((c) => c.last_used > 0), "the app wrote the context's last use");
    assert.ok(Object.values(written?.contexts ?? {}).some((c) => c.view === "apps/v1/deployments"), "and the view");
    console.log(`settings.json: ${JSON.stringify(app.profile.settings())}`);
  });

  let state;
  it("remembers context, namespaces, sort, hidden columns, panel width and dock height", T, async () => {
    const { app } = s;
    await waitLive(app);
    // Context: the alias (the kubeconfig's current-context is the test one).
    await selectContext(app, kc.alias);
    await waitLive(app);
    await app.nav("Pods");
    await app.waitFor(async () => (await activeKind(app)) === "Pods", { message: "Pods active" });
    await pickNamespaces(app, ["demo", "default"]);
    await app.waitFor(async () => (await namespaceChips(app)).length === 2, { message: "two namespace chips" });

    // Sort: Name descending (click it until it says so).
    const nameHeader = By.xpath("//*[@role='columnheader'][normalize-space()='Name' or starts-with(normalize-space(), 'Name ')]");
    for (let i = 0; i < 3; i++) {
      const sorts = Object.fromEntries(await headers(app));
      if (Object.entries(sorts).some(([k, v]) => k.startsWith("Name") && v === "descending")) break;
      await (await app.find(nameHeader)).click();
      await sleep(200);
    }
    const sorted = (await headers(app)).find(([k]) => k.startsWith("Name"));
    assert.equal(sorted?.[1], "descending", `Name header: ${JSON.stringify(sorted)}`);

    // Hidden column: Node, through the Columns chooser.
    await (await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"))).click();
    const nodeBox = await app.find(By.xpath("//*[@role='dialog'][@aria-label='Columns']//label[normalize-space()='Node']/input"));
    await nodeBox.click();
    await app.waitFor(async () => !(await headers(app)).some(([k]) => k.startsWith("Node")), { message: "Node column hidden" });
    await app.js("document.activeElement?.blur()");
    await (await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"))).click();

    // Panel width: open a pod and widen the panel from the keyboard (16 px a step).
    const pod = (await app.rows()).find(([, ns]) => ns === "demo")?.[0];
    assert.ok(pod, "a demo pod in the table");
    await (await app.find(app.row(pod, "demo"))).click();
    await app.find(byTestId("detail-panel"));
    const w0 = await panelWidth(app);
    const resizer = await app.find(byTestId("panel-resizer"));
    await app.js("arguments[0].focus()", resizer);
    for (let i = 0; i < 4; i++) await resizer.sendKeys(""); // ArrowLeft: wider
    await app.waitFor(async () => (await panelWidth(app)) >= w0 + 60, { message: "a wider panel" });

    // Dock height: a log tab, then drag the dock taller.
    await openPodLogs(app, "demo", pod);
    const h0 = await dockHeight(app);
    const h1 = await dragDock(app, -120);
    assert.ok(h1 > h0 + 80, `dock ${h0} -> ${h1}`);

    state = {
      width: await panelWidth(app),
      dock: Math.round(await dockHeight(app)),
      settings: null,
    };
    await sleep(1000);
    state.settings = app.profile.settings();
    console.log(`before restart: ${JSON.stringify({ width: state.width, dock: state.dock })}`);
    console.log(`settings.json: ${JSON.stringify(state.settings)}`);
    await app.shot("before-restart");

    await app.restart();
    await app.find(By.css("nav"));
    await app.waitFor(async () => (await contextValue(app)) === kc.alias, { timeout: 30_000, message: `context ${kc.alias} after the restart` });
    await waitLive(app);
    await app.waitFor(async () => (await activeKind(app)) === "Pods", { timeout: 30_000, message: "Pods after the restart" });
    await app.waitFor(async () => JSON.stringify((await namespaceChips(app)).sort()) === '["default","demo"]', {
      message: "demo and default chips after the restart",
    });
    const after = await headers(app);
    console.log(`headers after the restart: ${JSON.stringify(after)}`);
    assert.equal(after.find(([k]) => k.startsWith("Name"))?.[1], "descending", "Name still sorted descending");
    assert.ok(!after.some(([k]) => k.startsWith("Node")), "Node column still hidden");
    assert.match(await app.js(`return Array.from(document.querySelectorAll("button")).map((b) => b.textContent.trim()).find((t) => t.startsWith("Columns")) ?? ""`), /1 hidden/);
    // The panel isn't reopened; its width comes back when a pod is opened.
    const pod2 = (await app.rows()).find(([, ns]) => ns === "demo")?.[0];
    await (await app.find(app.row(pod2, "demo"))).click();
    await app.find(byTestId("detail-panel"));
    assert.equal(await panelWidth(app), state.width, "panel width");
    // The dock is closed after a restart (its tabs aren't kept); its height is.
    await openPodLogs(app, "demo", pod2);
    assert.ok(Math.abs((await dockHeight(app)) - state.dock) <= 2, `dock height ${await dockHeight(app)} vs ${state.dock}`);
  });

  it(
    "saves a setting changed just before the window closes (exit flush)",
    { ...T, skip: cannotCloseLikeUser() },
    async () => {
      const { app } = s;
      const pid = appPid(app.profile.home);
      assert.ok(pid, "the app's pid");
      const ids = x11Windows(pid);
      assert.ok(ids.length > 0, "the app's X11 window");
      await app.js("document.activeElement?.blur()");
      await app.driver.actions().keyDown("").sendKeys(",").keyUp("").perform(); // Ctrl+,
      await app.find(byTestId("settings"));
      const now = app.profile.settings()?.theme;
      const want = now === "light" ? "dark" : "light";
      const radio = await app.find(By.css(`[data-testid="settings"] input[name="theme"][value="${want}"]`));
      // Click, then close the window at once: the debounced write (400 ms)
      // has not run yet, only the exit flush can save it.
      const t0 = Date.now();
      await app.js("arguments[0].click()", radio);
      const clicked = Date.now() - t0;
      execFileSync("python3", [WM_CLOSE, ...ids], { stdio: "inherit" });
      const closed = Date.now() - t0;
      console.log(`clicked ${want} after ${clicked} ms, window close sent after ${closed} ms`);
      assert.ok(closed < 400, `the close was sent within the debounce (${closed} ms)`);
      await app.waitFor(() => !existsSync(`/proc/${pid}`), { timeout: 15_000, message: "the app to exit" });
      const saved = JSON.parse(readFileSync(app.profile.settingsPath, "utf8"));
      assert.equal(saved.theme, want, `theme in settings.json after exit: ${saved.theme}`);
      await app.restart({ wait: 0 });
      await waitTheme(app, want, { timeout: 20_000 });
    },
  );

  it("starts on defaults from a garbage settings.json and keeps it aside", T, async () => {
    const { app } = s;
    await app.restart({
      wait: 0,
      // Between stop and start, so the old app can't overwrite it.
      beforeStart: () => app.profile.writeSettings("{ not json"),
    });
    await waitLive(app);
    await app.waitFor(async () => (await activeKind(app)) === "Overview", { message: "Overview (the default view)" });
    const aside = `${app.profile.settingsPath}.corrupt`;
    assert.equal(readFileSync(aside, "utf8"), "{ not json");
  });
});
