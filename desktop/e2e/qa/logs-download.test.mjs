// Helper: a fixed downloads dir (the profile's $HOME/Downloads,
// lib/profile.mjs).
// Check (#19): Download in a pod's log tab writes the log to ~/Downloads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, loggerPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 120_000 };
let ns;

describe("log download", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-logs", loggerPodYaml("chatty"));
    waitPodReady(ns, "chatty");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("logs-download");

  it("Download saves the log lines to ~/Downloads", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "chatty");
    await (await app.find(By.xpath("//*[@data-testid='detail-panel']//button[normalize-space()='Logs']"))).click();
    const tab = `[data-testid="dock"] [data-tab="logs:${ns}/chatty"]`;
    await app.waitFor(async () => (await app.driver.findElements(By.css(`${tab} [data-testid="log-line"]`))).length >= 2, {
      message: "log lines in the dock tab",
    });
    await (await app.find(By.xpath(`//*[@data-tab='logs:${ns}/chatty']//button[normalize-space()='Download']`))).click();
    const path = await app.profile.waitForDownload(/^chatty_.*\.log$/);
    const text = readFileSync(path, "utf8");
    assert.match(text, /qa line 0/);
    // The page says where it went.
    await app.waitFor(async () => (await app.js("return document.body.innerText")).includes(`saved to ${path}`), {
      message: `"saved to ${path}"`,
    });
    console.log(`downloaded ${path}`);
  });
});
