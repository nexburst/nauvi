// Helper: pausing the control plane (lib/control-plane.mjs), always
// unpaused afterwards.
// Checks (#469, #462): Port Forwards watches nothing, so its health check
// (cmd_cluster_health, the watches' /readyz probe, every 10 s) is what
// notices the API server going away. With it paused, the header says
// "Cluster unreachable" within UNREACHABLE_MS, with the banner and a red
// dot on the cluster in the tree; after the unpause it goes Live again
// within LIVE_MS and the banner goes. Screenshots in light and dark.
//
// A paused API server accepts connections but never answers: a check waits
// 5 s for it, and the next one runs 10 s after the last: about 25 s at most.
// The pause lasts at most QA_PAUSE_MAX_MS (45 s by default; the local
// cluster is shared). Skipped without docker access to the kind node, or
// with QA_NO_PAUSE=1.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { cannotPause, withControlPlanePaused } from "../lib/control-plane.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { bannerText } from "../lib/table.mjs";

const MAX_PAUSE = Number(process.env.QA_PAUSE_MAX_MS || 45_000);
// Up to 10 s to the next check, 5 s for it to time out, the rest is
// WebDriver polling.
const UNREACHABLE_MS = 30_000;
// After the unpause: the next check, at most 10 s away.
const LIVE_MS = 30_000;
const T = { timeout: MAX_PAUSE + 120_000 };
const skip =
  cannotPause() || (MAX_PAUSE < UNREACHABLE_MS + 10_000 && `QA_PAUSE_MAX_MS is under ${UNREACHABLE_MS + 10_000}`);

const dotOfShown = (app) =>
  app.js(`return document.querySelector('[data-testid="cluster-node"][data-state="visible"] .dot')?.className ?? ""`);

describe("Port Forwards notices the control plane pausing", { timeout: MAX_PAUSE + 3 * 60_000, skip }, () => {
  const s = appSession("reconnect-watchless");

  it("says Cluster unreachable within 30 s of the pause and Live within 30 s after", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    await app.nav("Port Forwards");
    await app.waitFor(async () => (await app.statusText()) === "Live", { message: "Live on Port Forwards" });
    assert.match(await dotOfShown(app), /connected/);
    let tookMs = 0;
    await withControlPlanePaused(
      async () => {
        const start = Date.now();
        await app.waitFor(async () => (await app.statusText()) === "Cluster unreachable", {
          timeout: UNREACHABLE_MS,
          interval: 500,
          message: `header status "Cluster unreachable" within ${UNREACHABLE_MS / 1000} s of the pause`,
        });
        tookMs = Date.now() - start;
        console.log(`Cluster unreachable shown ${(tookMs / 1000).toFixed(1)} s after the pause`);
        assert.equal(await app.statusState(), "error");
        const banner = await bannerText(app);
        console.log(`banner: ${banner}`);
        assert.match(banner, /not answering|Lost the connection/);
        assert.match(await dotOfShown(app), /failed/);
        for (const theme of ["light", "dark"]) {
          await setTheme(app, theme);
          await sleep(300);
          await app.shot(`paused-${theme}`);
        }
        await setTheme(app, null);
      },
      { maxMs: MAX_PAUSE },
    );
    assert.ok(tookMs <= UNREACHABLE_MS, `Cluster unreachable after ${tookMs} ms`);
    const back = Date.now();
    await waitLive(app, LIVE_MS);
    console.log(`Live again ${((Date.now() - back) / 1000).toFixed(1)} s after the API server answered`);
    await app.waitFor(async () => (await bannerText(app)) === "", { message: "the banner to go" });
    assert.match(await dotOfShown(app), /connected/);
  });
});
