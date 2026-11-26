// Helper: pausing the control plane (lib/control-plane.mjs), always
// unpaused afterwards.
// Checks (#526): with the API server paused for longer than the UI waits
// for a reconnect (RETRY_GIVE_UP_MS in ui-src/src/lib/retry.ts, five
// minutes), the Overview stops its feed: the header says "Not connected"
// and the banner "Stopped retrying." with a Retry button (screenshots in
// light and dark). After the unpause nothing restarts by itself until the
// machine wakes or the network comes back: an `online` event (what a VPN
// coming back up fires) gets it Live again within LIVE_MS, with no banner.
//
// The pause needs about 23 s to be noticed (src/liveness.rs) plus the five
// minutes, so it runs only where QA_PAUSE_MAX_MS allows NEEDED_MS: qa.yml
// sets six minutes on its own cluster; locally (45 s) it is skipped.
// Skipped without docker access to the kind node, or with QA_NO_PAUSE=1.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { cannotPause, withControlPlanePaused } from "../lib/control-plane.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { bannerText } from "../lib/table.mjs";

const MAX_PAUSE = Number(process.env.QA_PAUSE_MAX_MS || 45_000);
const GIVE_UP_MS = 5 * 60_000;
// Reconnecting within 30 s, the give-up, and room for WebDriver polling.
const NEEDED_MS = GIVE_UP_MS + 50_000;
const LIVE_MS = 60_000;
const T = { timeout: MAX_PAUSE + 180_000 };
const skip = cannotPause() || (MAX_PAUSE < NEEDED_MS && `QA_PAUSE_MAX_MS is under ${NEEDED_MS} (the give-up is five minutes)`);

const retryButton = (app) =>
  app.js(`const b = document.querySelector('[data-testid="banner-retry"]');
    return b && b.offsetParent !== null ? b.textContent.trim() : "";`);

describe("a feed that stopped retrying comes back when the network does", { timeout: MAX_PAUSE + 4 * 60_000, skip }, () => {
  const s = appSession("reconnect-giveup");

  it("stops after five minutes of Reconnecting…, offers Retry, and goes Live on `online`", T, async () => {
    const { app } = s;
    await app.nav("Overview");
    await waitLive(app);
    assert.equal(await retryButton(app), "", "no Retry while Live");
    await withControlPlanePaused(
      async () => {
        await app.waitFor(async () => (await app.statusText()).startsWith("Reconnecting"), {
          timeout: 30_000,
          interval: 500,
          message: 'header status "Reconnecting…"',
        });
        const since = Date.now();
        assert.equal(await retryButton(app), "Retry", "Retry while reconnecting");
        await app.shot("reconnecting");
        await app.waitFor(async () => (await app.statusText()) === "Not connected", {
          timeout: GIVE_UP_MS + 20_000,
          interval: 2_000,
          message: 'header status "Not connected" after the give-up',
        });
        console.log(`stopped ${((Date.now() - since) / 1000).toFixed(1)} s after Reconnecting… showed`);
        const banner = await bannerText(app);
        console.log(`banner: ${banner}`);
        assert.match(banner, /Stopped retrying\.$/);
        assert.equal(await retryButton(app), "Retry");
        for (const theme of ["light", "dark"]) {
          await setTheme(app, theme);
          await sleep(300);
          await app.shot(`stopped-${theme}`);
        }
        await setTheme(app, null);
      },
      { maxMs: MAX_PAUSE },
    );
    // The API server answers again; the stopped feed does not know yet.
    await sleep(15_000);
    assert.equal(await app.statusText(), "Not connected", "nothing restarts before a wake");
    await app.shot("answering-not-restarted");
    // What the webview gets when a network interface (a VPN) comes back.
    await app.js(`window.dispatchEvent(new Event("online"))`);
    const back = Date.now();
    await waitLive(app, LIVE_MS);
    console.log(`Live ${((Date.now() - back) / 1000).toFixed(1)} s after the online event`);
    await app.waitFor(async () => (await bannerText(app)) === "", { message: "the banner to go" });
    assert.equal(await retryButton(app), "");
  });
});
