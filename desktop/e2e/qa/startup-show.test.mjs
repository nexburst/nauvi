// #369: windows open hidden and show once their page starts loading, so
// WebKitGTK's first paint no longer waits up to 500 ms for a web process
// that is not ready yet.
// - the app binary run directly (no WebDriver, a private session bus), STARTS
//   times: each start logs "page load started" and then shows its window (a
//   viewable X11 window); at most one start is more than STALL_MS slower than
//   the fastest (before the fix about one start in ten on this box, and
//   about half on the CI runner, took about 550 ms longer)
// - under WebDriver: the window is shown, in the Light and Dark theme
//
// Linux/X11 only (the stall and the window check are X11's).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { createProfile } from "../lib/profile.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, unreachableKubeconfig, waitLive } from "../lib/qa.mjs";
import { appBinary, cannotLaunchTwice, startBus } from "../lib/second-launch.mjs";
import { x11Windows } from "../lib/window.mjs";
import { appPid } from "../lib/dock.mjs";
import { CONTEXT } from "../lib/app.mjs";

const T = { timeout: 300_000 };
const STARTS = 12;
const STALL_MS = 350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start the binary once: ms until it logs "page load started", and ms until
 * its window is viewable (polled every 20 ms, at most 10 s).
 */
async function directStart(kubeconfig) {
  const bus = await startBus();
  const profile = createProfile();
  const env = {
    ...process.env,
    ...profile.env(),
    KUBECONFIG: kubeconfig,
    NAUVI_NO_SHELL_ENV: "1",
    DBUS_SESSION_BUS_ADDRESS: bus.address,
  };
  const t0 = performance.now();
  const proc = spawn(appBinary(), [], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  try {
    const load = await new Promise((ok, fail) => {
      let err = "";
      const timer = setTimeout(() => fail(new Error(`no "page load started" within 60 s:\n${err}`)), 60_000);
      proc.once("error", fail);
      proc.stderr.on("data", (d) => {
        err += d;
        if (/page load started/.test(err)) {
          clearTimeout(timer);
          ok(Math.round(performance.now() - t0));
        }
      });
    });
    let shown = null;
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      if (x11Windows(proc.pid).length === 1) {
        shown = Math.round(performance.now() - t0);
        break;
      }
      await sleep(20);
    }
    return { load, shown };
  } finally {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* gone */
    }
    await sleep(500);
    bus.stop();
    profile.remove();
  }
}

describe("#369: windows show when their page starts loading", { timeout: 15 * 60_000, skip: cannotLaunchTwice() }, () => {
  it(`${STARTS} direct starts: the window shows, and no start stalls`, T, async () => {
    const kc = unreachableKubeconfig();
    const starts = [];
    for (let i = 0; i < STARTS; i++) starts.push(await directStart(kc));
    const loads = starts.map((s) => s.load);
    console.log(`page load started (ms): ${loads.join(", ")}`);
    console.log(`window shown (ms): ${starts.map((s) => s.shown).join(", ")}`);
    for (const [i, s] of starts.entries()) assert.ok(s.shown !== null, `start ${i + 1}: the window is shown`);
    const fastest = Math.min(...loads);
    const stalled = loads.filter((ms) => ms > fastest + STALL_MS);
    assert.ok(stalled.length <= 1, `starts more than ${STALL_MS} ms slower than the fastest (${fastest} ms): ${stalled.join(", ")}`);
  });

  describe("under WebDriver", () => {
    const s = appSession("startup-show");

    it("the main window is shown, Light theme", T, async () => {
      const { app } = s;
      await waitLive(app);
      assert.equal(x11Windows(appPid(app.profile.home)).length, 1, "one viewable window");
      await setTheme(app, "light");
    });

    it("Dark theme", T, async () => {
      const { app } = s;
      await setTheme(app, "dark");
      assert.ok((await app.statusText()) === "Live", `connected to ${CONTEXT}`);
    });
  });
});
