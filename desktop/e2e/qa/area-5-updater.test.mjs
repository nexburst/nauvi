// QA area 5 (#83): the update banner and the Settings toggle (PR #85), with
// the debug override: a local `latest.json` served by this process through
// KUBELOUPE_UPDATE_ENDPOINT. Nothing is downloaded or installed.
// Checks: a newer version shows the banner on start (main window), with
// Release notes opening the release page and, for a plain binary, "Download
// from the release page"; ✕ closes it; turning "Check for updates on start"
// off skips the check after a restart, while Check for updates in Settings
// still asks; the palette reports "latest version" and errors; a failed
// check on start stays quiet; a second window does not check on start;
// without the override a debug build never asks.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { openNewWindow, switchTo, windowHandles } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the server answers: a version, or an HTTP error status. */
const served = { version: "9.9.9", status: 200, requests: 0 };
let server;
let endpoint;

function latestJson(version) {
  return JSON.stringify({
    version,
    notes: "QA area 5 test release",
    pub_date: "2026-11-01T00:00:00Z",
    platforms: {
      "linux-x86_64": { signature: "not-a-signature", url: "http://127.0.0.1:1/kubeloupe.AppImage" },
    },
  });
}

const count = (app, css) => app.js(`return document.querySelectorAll(arguments[0]).length`, css);
const textOf = (app, testid) => app.js(`return document.querySelector('[data-testid="${testid}"]')?.innerText ?? ""`);

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  await app.find(byTestId("settings"));
  await app.js(`document.querySelector('[data-testid="update-settings"]').scrollIntoView()`);
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
}

async function settingsCheck(app) {
  await (await app.find(By.xpath("//*[@data-testid='update-settings']//button[normalize-space()='Check for updates']"))).click();
  return app.waitFor(
    async () => {
      const t = await textOf(app, "update-status");
      return t && t !== "Checking…" && t !== "Not checked yet." ? t : null;
    },
    { timeout: 30_000, message: "the check's result in Settings" },
  );
}

describe("area 5: updates with a local latest.json", { timeout: 15 * 60_000 }, () => {
  before(async () => {
    server = createServer((req, res) => {
      served.requests++;
      if (served.status !== 200) {
        res.writeHead(served.status);
        res.end("qa: failing on purpose");
        return;
      }
      const body = latestJson(served.version);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${server.address().port}/latest.json`;
  });
  after(() => server?.close());
  const s = appSession("area-5-updater", () => ({ env: { KUBELOUPE_UPDATE_ENDPOINT: endpoint } }));

  it("shows the banner for 9.9.9 on start", T, async () => {
    const { app } = s;
    await waitLive(app);
    const banner = await app.find(byTestId("update-banner"), { timeout: 30_000 });
    const text = await app.js("return arguments[0].innerText", banner);
    console.log(`banner: ${text.replace(/\s+/g, " ")}; requests ${served.requests}`);
    assert.match(text, /kubeloupe 9\.9\.9 is available/);
    assert.match(text, /Download from the release page/, "a plain binary is sent to the release page");
    assert.equal(served.requests, 1);
  });

  it("Release notes opens the release page; ✕ closes the banner", T, async () => {
    const { app } = s;
    await (await app.find(By.xpath("//*[@data-testid='update-banner']//button[normalize-space()='Release notes']"))).click();
    const url = await app.waitFor(() => app.profile.opened().at(-1), { message: "a URL opened" });
    console.log(`opened ${url}`);
    assert.match(url, /^https:\/\/github\.com\/pedrosanzmtz\/kubeloupe\/releases\/.*9\.9\.9/);
    await (await app.find(By.css('[data-testid="update-banner"] button[aria-label="Dismiss update"]'))).click();
    await app.waitFor(async () => (await count(app, '[data-testid="update-banner"]')) === 0, { message: "banner closed" });
  });

  it("turning the start-up check off skips it after a restart; Settings still checks", T, async () => {
    const { app } = s;
    await openSettings(app);
    const box = await app.find(By.xpath("//*[@data-testid='update-settings']//label[contains(., 'Check for updates on start')]/input"));
    assert.equal(await box.isSelected(), true);
    await box.click();
    await app.waitFor(() => app.profile.settings()?.check_updates === false, { message: "check_updates false in settings.json" });
    await app.shot("settings-updates-off");
    const before = served.requests;
    await app.restart();
    await waitLive(app);
    await sleep(5000);
    assert.equal(served.requests, before, "no request on start");
    assert.equal(await count(app, '[data-testid="update-banner"]'), 0);
    await openSettings(app);
    const result = await settingsCheck(app);
    console.log(`Settings check: ${result}`);
    assert.match(result, /9\.9\.9 is available/);
    assert.equal(served.requests, before + 1);
    await closeSettings(app);
    await app.find(byTestId("update-banner"));
  });

  it("the palette reports the latest version and errors", T, async () => {
    const { app } = s;
    await (await app.find(By.css('[data-testid="update-banner"] button[aria-label="Dismiss update"]'))).click();
    served.version = "0.1.0";
    await app.palette("check for upd", "Check for updates");
    const notice = await app.find(byTestId("update-notice"), { timeout: 30_000 });
    await app.waitFor(async () => /is the latest version/.test(await app.js("return arguments[0].innerText", notice)), {
      message: "up to date",
    });
    console.log(`notice: ${await textOf(app, "update-notice")}`);
    served.status = 500;
    await app.palette("check for upd", "Check for updates");
    await app.waitFor(async () => /Could not check for updates/.test(await textOf(app, "update-notice")), { timeout: 30_000, message: "the error" });
    console.log(`error notice: ${await textOf(app, "update-notice")}`);
    await app.shot("palette-error-notice");
  });

  it("a failed check on start stays quiet", T, async () => {
    const { app } = s;
    await app.restart({ beforeStart: () => app.profile.writeSettings({ ...app.profile.settings(), check_updates: true }) });
    const before = served.requests;
    await waitLive(app);
    await app.waitFor(() => served.requests > before, { timeout: 30_000, message: "the start-up check" });
    await sleep(3000);
    assert.equal(await count(app, '[data-testid="update-banner"], [data-testid="update-notice"]'), 0, "no banner or notice");
  });

  it("a second window does not check on start", T, async () => {
    const { app } = s;
    served.status = 200;
    served.version = "9.9.9";
    const before = served.requests;
    const main = await app.driver.getWindowHandle();
    const second = await openNewWindow(app);
    await switchTo(app, second);
    await waitLive(app);
    await sleep(4000);
    assert.equal(served.requests, before, "no request from the second window");
    assert.equal(await count(app, '[data-testid="update-banner"]'), 0);
    await app.driver.close();
    await switchTo(app, main);
    await app.waitFor(async () => (await windowHandles(app)).length === 1, { message: "one window" });
  });
});

describe("area 5: updates without the override", { timeout: 5 * 60_000 }, () => {
  const s = appSession("area-5-updater-off");

  it("a debug build does not check", T, async () => {
    const { app } = s;
    await waitLive(app);
    await openSettings(app);
    const result = await settingsCheck(app);
    console.log(`Settings check: ${result}`);
    assert.match(result, /Development builds do not check for updates/);
    assert.equal(await count(app, '[data-testid="update-banner"]'), 0);
  });
});
