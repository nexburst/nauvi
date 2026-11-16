// Helpers: intercepting "Open in browser" (the profile's xdg-open recorder,
// lib/profile.mjs) and reading the clipboard (lib/clipboard.mjs).
// Checks (#65): a pod forward works with curl, Open in browser asks the
// system to open its URL, Copy URL puts it on the clipboard, Stop ends it.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { hookClipboard, waitForClipboard } from "../lib/clipboard.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { byTestId, xq } from "../lib/app.mjs";

const T = { timeout: 120_000 };
let ns;
let url;

describe("port-forward: open in browser and copy URL", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-pf", httpPodYaml("web", 8080, "hello from kubeloupe qa"));
    waitPodReady(ns, "web");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("port-forward");

  it("forwards a pod port that answers on 127.0.0.1", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "web");
    const panel = await app.find(byTestId("detail-panel"));
    await app.setValue(await panel.findElement(By.css('input[aria-label="Pod port"]')), "8080");
    await (await panel.findElement(By.xpath(".//button[normalize-space()='Forward']"))).click();
    const status = await app.waitFor(
      async () => {
        const text = await panel.getText();
        return text.match(/Forwarding (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? null;
      },
      { message: "Forwarding http://127.0.0.1:<port>" },
    );
    url = status;
    const body = await (await fetch(url)).text();
    assert.match(body, /hello from kubeloupe qa/);
  });

  it("Open asks the system to open the URL", T, async () => {
    const { app } = s;
    await app.nav("Port Forwards");
    await (await app.find(By.css(`button[aria-label=${JSON.stringify(`Open ${url} in the browser`)}]`))).click();
    await app.waitFor(() => app.profile.opened().includes(url), {
      timeout: 10_000,
      message: `${url} to be opened (opened: ${app.profile.opened().join(", ")})`,
    });
  });

  it("Copy URL puts the URL on the clipboard", T, async () => {
    const { app } = s;
    await hookClipboard(app);
    await (await app.find(By.css(`button[aria-label=${JSON.stringify(`Copy ${url}`)}]`))).click();
    const clip = await waitForClipboard(app, url);
    console.log(`clipboard read from: ${clip.source}`);
    // No fallback notice: the copy worked.
    const text = await app.js("return document.body.innerText");
    assert.ok(!text.includes("Could not copy to the clipboard"), "the copy failed in the page");
  });

  it("Stop ends the forward (it stays saved, #217)", T, async () => {
    const { app } = s;
    await (await app.find(By.css(`button[aria-label=${JSON.stringify(`Stop ${url}`)}]`))).click();
    await app.find(By.xpath(`//*[@data-testid='forward-row']//*[normalize-space()=${xq("Stopped")}]`));
    await assert.rejects(fetch(url));
  });
});
