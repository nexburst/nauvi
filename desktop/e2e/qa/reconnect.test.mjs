// Helper: pausing the control plane (lib/control-plane.mjs), always
// unpaused afterwards.
// Checks (#19, #90): with the API server paused, the header says
// "Reconnecting…" within RECONNECT_MS; after the unpause the Pods table goes
// Live again within LIVE_MS.
//
// A paused API server accepts connections but never answers. The watches'
// liveness guard (src/liveness.rs) probes /readyz after 10 s without news
// and gives up after two unanswered probes: about 23 s at most. Without it
// this took about 5 minutes (kube's read timeout). The pause lasts at most
// QA_PAUSE_MAX_MS (45 s by default; the local cluster is shared).
// Skipped without docker access to the kind node, or with QA_NO_PAUSE=1.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cannotPause, withControlPlanePaused } from "../lib/control-plane.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const MAX_PAUSE = Number(process.env.QA_PAUSE_MAX_MS || 45_000);
// The guard's worst case is 23 s; the rest is the UI and WebDriver polling.
const RECONNECT_MS = 30_000;
// After the unpause: the guard probes every 3 s, then the watches list again.
const LIVE_MS = 30_000;
const T = { timeout: MAX_PAUSE + 120_000 };
const skip = cannotPause() || (MAX_PAUSE < RECONNECT_MS + 5_000 && `QA_PAUSE_MAX_MS is under ${RECONNECT_MS + 5_000}`);

describe("reconnecting after the control plane pauses", { timeout: MAX_PAUSE + 3 * 60_000, skip }, () => {
  const s = appSession("reconnect");

  it("shows Reconnecting… within 30 s of the pause and goes Live within 30 s after", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    let tookMs = 0;
    await withControlPlanePaused(
      async () => {
        const start = Date.now();
        await app.waitFor(async () => (await app.statusText()).startsWith("Reconnecting"), {
          timeout: RECONNECT_MS,
          interval: 500,
          message: `header status "Reconnecting…" within ${RECONNECT_MS / 1000} s of the pause`,
        });
        tookMs = Date.now() - start;
        console.log(`Reconnecting… shown ${(tookMs / 1000).toFixed(1)} s after the pause`);
        await app.shot("paused");
      },
      { maxMs: MAX_PAUSE },
    );
    assert.ok(tookMs <= RECONNECT_MS, `Reconnecting… after ${tookMs} ms`);
    // withControlPlanePaused returns once the API server answers /readyz.
    const back = Date.now();
    await waitLive(app, LIVE_MS);
    console.log(`Live again ${((Date.now() - back) / 1000).toFixed(1)} s after the API server answered`);
  });
});
