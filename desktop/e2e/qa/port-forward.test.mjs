// Helpers: intercepting "Open in browser" (the profile's xdg-open recorder,
// lib/profile.mjs) and reading the clipboard (lib/clipboard.mjs).
// Checks (#65): a pod forward works with curl, Open in browser asks the
// system to open its URL, Copy URL puts it on the clipboard, Stop ends it.
// #293: a client that resets its connection mid-response (as browsers do on
// Windows) leaves the forward running without an error.

import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { hookClipboard, waitForClipboard } from "../lib/clipboard.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { byTestId, xq } from "../lib/app.mjs";

const T = { timeout: 120_000 };
let ns;
let url;

/** A 20 MB file next to index.html, so a client can leave mid-response. */
const podYaml = httpPodYaml("web", 8080, "hello from kubeloupe qa").replace(
  "exec httpd",
  "head -c 20000000 /dev/zero > /www/big && exec httpd",
);

/** GET /big, read `bytes` of the answer (0: none), then reset (RST) the connection. */
function resetMidResponse(port, bytes) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write("GET /big HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      if (bytes === 0) sock.resetAndDestroy();
    });
    let got = 0;
    sock.on("data", (d) => {
      got += d.length;
      if (got >= bytes && !sock.destroyed) {
        sock.resetAndDestroy();
      }
    });
    sock.on("close", () => resolve(got));
    sock.on("error", reject);
  });
}

describe("port-forward: open in browser and copy URL", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-pf", podYaml);
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

  it("a client that resets its connection mid-response is not an error (#293)", T, async () => {
    const { app } = s;
    await app.nav("Port Forwards");
    const port = Number(new URL(url).port);
    for (const bytes of [64 * 1024, 1, 0, 1024 * 1024]) {
      const got = await resetMidResponse(port, bytes);
      console.log(`reset after ${got} bytes (asked ${bytes})`);
    }
    // Let the forward record how they ended, and the view poll it.
    await new Promise((r) => setTimeout(r, 2500));
    const status = await app.js(
      `const r = document.querySelector('[data-testid="forward-row"]');
       return { text: r?.innerText.replace(/\\s+/g, " ") ?? "", red: !!r?.querySelector(".error-text") };`,
    );
    console.log(`row after the resets: ${JSON.stringify(status)}`);
    await app.shot("after-client-resets");
    assert.equal(status.red, false, `no error in the row: ${status.text}`);
    assert.match(status.text, /Listening|Active/);
    assert.doesNotMatch(status.text, /reset|broken pipe|aborted/i);
    // The forward still answers.
    assert.match(await (await fetch(url)).text(), /hello from kubeloupe qa/);
  });

  it("Open asks the system to open the URL", T, async () => {
    const { app } = s;
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
