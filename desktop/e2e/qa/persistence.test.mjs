// Helper: restarting the app with the same config dir (App.restart, with
// the profile from lib/profile.mjs).
// Checks (#39): the view survives a restart and settings.json exists; a
// garbage settings.json gives the defaults and is kept as .corrupt.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 120_000 };
const activeKind = (app) => app.js(`return document.querySelector("nav button.active")?.textContent.trim() ?? ""`);

describe("settings survive a restart", { timeout: 10 * 60_000 }, () => {
  const s = appSession("persistence");

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
    assert.ok(existsSync(app.profile.settingsPath), `${app.profile.settingsPath} exists`);
    console.log(`settings.json: ${JSON.stringify(app.profile.settings())}`);
  });

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
