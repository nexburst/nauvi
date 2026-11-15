// #182: window size and position are remembered across restarts, a window
// opened with "New window" is cascaded from the one it was opened from
// (not stacked exactly on top of it), and a saved position that is off
// every monitor comes back on screen. Under Xvfb (no window manager) a
// window is exactly where it is put; qa.sh's screen is 1600x1000.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONTEXT } from "../lib/app.mjs";
import { aliasKubeconfig } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { openNewWindow, selectContext, switchTo, windowHandles } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let kc;

const rectOf = (app) => app.driver.manage().window().getRect();
const near = (a, b, what) => {
  for (const k of ["x", "y", "width", "height"]) {
    assert.ok(Math.abs(a[k] - b[k]) <= 2, `${what}: ${k} ${a[k]}, expected ${b[k]} (${JSON.stringify(a)})`);
  }
};
const stateFile = (app) => join(app.profile.configDir, "window-state.json");
const saved = (app) => (existsSync(stateFile(app)) ? JSON.parse(readFileSync(stateFile(app), "utf8")) : null);

/** Every window's rect, by the context in its header. */
async function rectsByContext(app) {
  const out = {};
  for (const h of await windowHandles(app)) {
    await switchTo(app, h);
    const ctx = await app.waitFor(
      () => app.js(`return document.querySelector('select[aria-label="Cluster context"]')?.value || null`),
      { message: "a context in the window" },
    );
    out[ctx] = { handle: h, rect: await rectOf(app) };
  }
  return out;
}

describe("#182: window size and position", { timeout: 10 * 60_000 }, () => {
  after(() => kc?.remove());
  const s = appSession("window-geometry", () => {
    kc = aliasKubeconfig();
    return { kubeconfig: kc.path };
  });
  const MAIN = { x: 200, y: 70, width: 1100, height: 700 };
  const SECOND = { x: 40, y: 40, width: 1000, height: 720 };

  it("New window opens cascaded from the window it was opened from", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.driver.manage().window().setRect(MAIN);
    await sleep(500);
    const main = await rectOf(app);
    near(main, MAIN, "the main window after setRect");
    const [mainHandle] = await windowHandles(app);
    const second = await openNewWindow(app);
    await switchTo(app, second);
    await selectContext(app, kc.alias);
    await waitLive(app);
    const r = await rectOf(app);
    console.log(`main ${JSON.stringify(main)}, new window ${JSON.stringify(r)}`);
    assert.notDeepEqual({ x: r.x, y: r.y }, { x: main.x, y: main.y }, "the new window is not on top of the main one");
    near(r, { ...main, x: main.x + 32, y: main.y + 32 }, "the new window");
    await switchTo(app, mainHandle);
  });

  it("each window comes back where it was, at its size, after a restart", T, async () => {
    const { app } = s;
    const before = await rectsByContext(app);
    await switchTo(app, before[kc.alias].handle);
    await app.driver.manage().window().setRect(SECOND);
    await app.waitFor(() => saved(app)?.windows?.[0]?.x === SECOND.x || null, { timeout: 10_000, message: "window-state.json" });
    console.log(`window-state.json: ${readFileSync(stateFile(app), "utf8")}`);
    await app.restart();
    await waitLive(app);
    const after = await rectsByContext(app);
    console.log(`after the restart: ${JSON.stringify(Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v.rect])))}`);
    near(after[CONTEXT].rect, MAIN, `${CONTEXT} (main)`);
    near(after[kc.alias].rect, SECOND, kc.alias);
    await switchTo(app, after[CONTEXT].handle);
  });

  it("a position off every monitor comes back on screen", T, async () => {
    const { app } = s;
    await app.restart({
      beforeStart: () => {
        const st = saved(app);
        st.main = { x: 5000, y: 3000, width: 1100, height: 700 };
        writeFileSync(stateFile(app), JSON.stringify(st));
      },
    });
    await waitLive(app);
    const all = await rectsByContext(app);
    const r = all[CONTEXT].rect;
    console.log(`main after an off-screen save: ${JSON.stringify(r)}`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + 100 <= 1600 && r.y + 30 <= 1000, `on the 1600x1000 screen: ${JSON.stringify(r)}`);
    assert.equal(r.width, 1100);
    await switchTo(app, all[CONTEXT].handle);
  });
});
