// #498: what stops a port-forward, checked in the real app, and the words
// that say it. The Port forward… dialog and the Port Forwards view say the
// same sentence ("It keeps running until you stop it, disconnect its
// cluster, close this window or quit nauvi"); shots of both in light and
// dark. "Open in browser when it starts" starts checked for a Service port
// named http (port 80) and opens the URL.
// Checks that sentence: closing the detail panel and a dock tab, leaving the
// view and showing another cluster leave the forward running; Stop ends it
// (it stays saved); closing the window it runs in ends it (needs the X
// tools); disconnecting its cluster ends it. Quitting is the app's exit,
// covered by the window and session tests.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { aliasKubeconfig, appPid, closeTab, openPodLogs } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { disconnectCluster, waitNodeState } from "../lib/tree.mjs";
import { cannotCloseLikeUser, closeLikeUser, openNewWindow, selectContext, switchTo, windowHandles } from "../lib/window.mjs";
import { contextMenu, menuItem, openKind } from "./area-2-helpers.mjs";

const T = { timeout: 120_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIFETIME = "until you stop it, disconnect its cluster, close this window or quit nauvi.";
const SERVICE = `
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - name: http
      port: 80
      targetPort: 8080
`;

let ns;
let kc;
let url;
let main;

/** Whether `u` answers (a closed forward refuses or times out). */
async function answers(u) {
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(3000) });
    return /hello from 498/.test(await res.text());
  } catch {
    return false;
  }
}

describe("what stops a port-forward (#498)", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-fwdstop", httpPodYaml("web", 8080, "hello from 498") + SERVICE);
    waitPodReady(ns, "web");
  });
  after(() => {
    deleteNamespace(ns);
    kc?.remove();
  });
  const s = appSession("forward-stop", () => {
    kc = aliasKubeconfig();
    return { kubeconfig: kc.path };
  });

  /** A shot in light and in dark theme, then back to the system theme. */
  async function shots(label) {
    for (const theme of ["light", "dark"]) {
      await setTheme(s.app, theme);
      await sleep(500); // let WebKitGTK repaint before the shot
      await s.app.shot(`${label}-${theme}`);
    }
    await setTheme(s.app, null);
  }

  const textOf = (testid) => s.app.js(`return document.querySelector('[data-testid="${testid}"]')?.innerText ?? ""`);

  async function forwardsView() {
    await s.app.nav("Port Forwards");
    return s.app.find(byTestId("port-forwards"));
  }

  it("the dialog says what stops it; Open in browser is on for port 80/http (light, dark)", T, async () => {
    const { app } = s;
    await waitLive(app);
    main = await app.driver.getWindowHandle();
    await openKind(app, "Services", ns, "web");
    await contextMenu(app, "web", ns);
    await menuItem(app, "Port forward…");
    const dialog = await app.find(byTestId("forward-dialog"));
    const select = await dialog.findElement(By.css('select[aria-label="Service port"]'));
    await app.waitFor(async () => (await select.getAttribute("value")) === "80", { message: "Service port 80 picked" });
    const open = await dialog.findElement(By.css('input[aria-label="Open in browser"]'));
    await app.waitFor(() => open.isSelected(), { message: "Open in browser checked for 80/http" });
    assert.equal(
      await textOf("forward-lifetime"),
      `Saved for this cluster in Network → Port Forwards. It keeps running ${LIFETIME}`,
    );
    assert.match(await dialog.getText(), /Leave empty to pick one for you \(the same port when it is free and ≥ 1024\)\./);
    await shots("dialog");
    await (await dialog.findElement(byTestId("forward-confirm"))).click();
    url = await app.waitFor(() => app.profile.opened().find((u) => u.startsWith("http://127.0.0.1:")), {
      message: `the browser opened (opened: ${app.profile.opened().join(", ")})`,
    });
    assert.ok(await answers(url), `${url} answers`);
  });

  it("the Port Forwards view says the same (light, dark)", T, async () => {
    const { app } = s;
    const view = await forwardsView();
    await app.waitFor(async () => (await view.getText()).includes(url), { message: `${url} listed` });
    assert.equal(await textOf("forwards-lifetime"), `Forwards are saved per cluster. Each keeps running ${LIFETIME}`);
    await shots("view");
  });

  it("closing the detail panel and a dock tab, and leaving the view, leave it running", T, async () => {
    const { app } = s;
    await openPodLogs(app, ns, "web");
    await closeTab(app, "Logs: web");
    await (await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Close details"]'))).click();
    await app.waitFor(async () => (await app.driver.findElements(byTestId("detail-panel"))).length === 0, { message: "panel closed" });
    assert.ok(await answers(url), "still forwarding with the tab and panel closed and the view left");
  });

  it("showing another cluster leaves it running; it is listed with its cluster", T, async () => {
    const { app } = s;
    await selectContext(app, kc.alias);
    await waitLive(app);
    assert.ok(await answers(url), "still forwarding after showing another cluster");
    await forwardsView();
    await app.find(By.xpath(`//*[@data-testid='port-forwards']//tr[contains(normalize-space(), ${xq(CONTEXT)})][contains(normalize-space(), ${xq(url)})]`));
    await app.shot("view-other-cluster");
    await selectContext(app, CONTEXT);
    await waitLive(app);
  });

  it("Stop ends it, and it stays saved", T, async () => {
    const { app } = s;
    const view = await forwardsView();
    await (await app.find(By.css(`button[aria-label=${JSON.stringify(`Stop ${url}`)}]`))).click();
    await app.waitFor(async () => !(await answers(url)), { message: `${url} closed after Stop` });
    await app.waitFor(async () => /Stopped/.test(await view.getText()), { message: "the row says Stopped" });
    await app.shot("stopped");
    // Start it again for the next checks.
    await (await app.find(By.css(`button[aria-label=${JSON.stringify(`Start svc/${ns}/web:80`)}]`))).click();
    url = await app.waitFor(async () => (await view.getText()).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], { message: "started again" });
    await app.waitFor(() => answers(url), { message: `${url} answers again` });
  });

  // WebDriver's Close Window would leave the native window and its session
  // open, so this needs the X tools.
  it("closing the window it runs in ends it; other windows' forwards run on", { ...T, skip: cannotCloseLikeUser() }, async () => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    const second = await openNewWindow(app);
    await switchTo(app, second);
    await waitLive(app);
    await app.openDetail("Pods", ns, "web");
    const panel = await app.find(byTestId("detail-panel"));
    await app.setValue(await panel.findElement(By.css('input[aria-label="Pod port"]')), "8080");
    await (await panel.findElement(By.xpath(".//button[normalize-space()='Forward']"))).click();
    const other = await app.waitFor(async () => (await panel.getText()).match(/Forwarding (http:\/\/127\.0\.0\.1:\d+)/)?.[1], {
      message: "Forwarding http://127.0.0.1:<port> in the second window",
    });
    assert.ok(await answers(other), `${other} answers`);
    // Titled after the alias, so only this window is closed.
    await selectContext(app, kc.alias);
    await waitLive(app);
    assert.ok(await answers(other), "still forwarding after the second window shows another cluster");
    await switchTo(app, main);
    assert.equal(closeLikeUser(pid, { title: kc.alias }).length, 1, `one window titled ${kc.alias}`);
    await app.waitFor(async () => (await windowHandles(app)).length === 1, { message: "one window left" });
    await app.waitFor(async () => !(await answers(other)), { message: `${other} closed with its window` });
    assert.ok(await answers(url), "the main window's forward runs on");
  });

  it("disconnecting its cluster ends it", T, async () => {
    const { app } = s;
    await selectContext(app, kc.alias);
    await waitLive(app);
    assert.ok(await answers(url), "running while another cluster is shown");
    await waitNodeState(app, CONTEXT, "connected");
    await disconnectCluster(app, CONTEXT);
    await waitNodeState(app, CONTEXT, "idle");
    await app.waitFor(async () => !(await answers(url)), { message: `${url} closed after disconnecting ${CONTEXT}` });
    await forwardsView();
    await app.shot("after-disconnect");
  });
});
