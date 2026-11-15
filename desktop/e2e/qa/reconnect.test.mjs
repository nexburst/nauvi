// Helper: pausing the control plane (lib/control-plane.mjs), always
// unpaused afterwards.
// Checks (#19): with the API server paused, the header says
// "Reconnecting…"; after the unpause the Pods table goes Live again.
//
// A paused API server accepts connections but never answers, so the app only
// notices when a watch request times out: up to about 5 minutes (kube's
// default watch and read timeouts). The pause lasts at most QA_PAUSE_MAX_MS:
// 45 s by default, since the local cluster is shared (too short to see
// "Reconnecting…" then); qa.yml, with its own cluster, sets 6 minutes.
// Skipped without docker access to the kind node, or with QA_NO_PAUSE=1.

import { describe, it } from "node:test";
import { cannotPause, withControlPlanePaused } from "../lib/control-plane.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const MAX_PAUSE = Number(process.env.QA_PAUSE_MAX_MS || 45_000);
const T = { timeout: MAX_PAUSE + 180_000 };
const skip = cannotPause() || false;

describe("reconnecting after the control plane pauses", { timeout: MAX_PAUSE + 5 * 60_000, skip }, () => {
  const s = appSession("reconnect");

  it("shows Reconnecting… while paused and goes Live after", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    await withControlPlanePaused(
      async () => {
        // Watches notice a dead connection on their next request or timeout.
        await app.waitFor(async () => (await app.statusText()).startsWith("Reconnecting"), {
          timeout: MAX_PAUSE - 5_000,
          message: 'header status "Reconnecting…"',
        });
        await app.shot("paused");
      },
      { maxMs: MAX_PAUSE },
    );
    await waitLive(app, 90_000);
  });
});
