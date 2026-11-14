// Helper: pausing the control plane (lib/control-plane.mjs), always
// unpaused afterwards.
// Checks (#19): with the API server paused, the header says
// "Reconnecting…"; after the unpause the Pods table goes Live again.
//
// Pauses the shared kind cluster for up to ~45 s. Skipped without docker
// access to the kind node, or with QA_NO_PAUSE=1.

import { describe, it } from "node:test";
import { cannotPause, withControlPlanePaused } from "../lib/control-plane.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 180_000 };
const skip = cannotPause() || false;

describe("reconnecting after the control plane pauses", { timeout: 10 * 60_000, skip }, () => {
  const s = appSession("reconnect");

  it("shows Reconnecting… while paused and goes Live after", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    await withControlPlanePaused(
      async () => {
        // Watches notice a dead connection on their next request or timeout.
        await app.waitFor(async () => (await app.statusText()).startsWith("Reconnecting"), {
          timeout: 40_000,
          message: 'header status "Reconnecting…"',
        });
        await app.shot("paused");
      },
      { maxMs: 45_000 },
    );
    await waitLive(app, 90_000);
  });
});
