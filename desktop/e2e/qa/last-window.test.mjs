// #174: on macOS closing the last window keeps the app in the Dock (checked
// by hand on a Mac). Here, on Linux, closing the last window must still quit
// the app and stop what that window started:
// - a pod port-forward answers; closing the window like a user
//   (WM_DELETE_WINDOW) quits the app and the forwarded port closes
// - closing a second window leaves the app running with the first, and its
//   forward keeps working

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { aliasKubeconfig, appPid } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { cannotCloseLikeUser, closeLikeUser, openNewWindow, selectContext, switchTo, windowHandles } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ns;
let kc;

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Forward port 8080 of pod `web` from the detail panel; returns its URL. */
async function forward(app) {
  await app.openDetail("Pods", ns, "web");
  const panel = await app.find(byTestId("detail-panel"));
  await app.setValue(await panel.findElement(By.css('input[aria-label="Pod port"]')), "8080");
  await (await panel.findElement(By.xpath(".//button[normalize-space()='Forward']"))).click();
  const url = await app.waitFor(async () => (await panel.getText()).match(/Forwarding (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? null, {
    message: "Forwarding http://127.0.0.1:<port>",
  });
  assert.match(await (await fetch(url)).text(), /hello from qa174/);
  return url;
}

describe("#174: closing the last window (Linux: quits)", { timeout: 10 * 60_000, skip: cannotCloseLikeUser() }, () => {
  before(() => {
    ns = tempNamespace("qa174", httpPodYaml("web", 8080, "hello from qa174"));
    waitPodReady(ns, "web");
    kc = aliasKubeconfig();
  });
  after(() => {
    deleteNamespace(ns);
    kc?.remove();
  });
  const s = appSession("last-window", () => ({ kubeconfig: kc.path }));

  it("closing a second window keeps the app and the first window's forward", T, async () => {
    const { app } = s;
    await waitLive(app);
    const url = await forward(app);
    const [main] = await windowHandles(app);
    const second = await openNewWindow(app);
    await switchTo(app, second);
    await selectContext(app, kc.alias);
    await waitLive(app);
    const pid = appPid(app.profile.home);
    closeLikeUser(pid, { title: kc.alias });
    await sleep(2000);
    assert.ok(isRunning(pid), "the app keeps running with the main window");
    await switchTo(app, main);
    assert.match(await (await fetch(url)).text(), /hello from qa174/, "the main window's forward still answers");
    await app.nav("Port Forwards");
    await app.find(By.css(`button[aria-label=${JSON.stringify(`Stop ${url}`)}]`));
    console.log(`after closing the second window: ${CONTEXT} forward ${url} still up`);
  });

  it("closing the last window quits the app and stops its port-forward", T, async () => {
    const { app } = s;
    const url = (await app.js("return document.body.innerText")).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(url, "a forward is listed");
    const pid = appPid(app.profile.home);
    closeLikeUser(pid);
    await app.waitFor(() => !isRunning(pid), { timeout: 15_000, message: "the app to exit" });
    await assert.rejects(fetch(url), "the forwarded port is closed");
    await app.restart({ wait: 0 });
    await waitLive(app);
  });
});
