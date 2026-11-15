// Remembering the extra windows across an exit (#126), with a second
// context on the same cluster (aliasKubeconfig).
// Checks: closing the extra window alone (WM_DELETE_WINDOW, like its close
// button) forgets it; closing every window at once, as a session logout or
// the window manager's "close all" does, keeps it in settings.windows and
// the next start reopens it on its context.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { aliasKubeconfig, appPid } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { cannotCloseLikeUser, closeLikeUser, switchTo, windowHandles, x11Windows } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = cannotCloseLikeUser();
const contextValue = (app) => app.js(`return document.querySelector('select[aria-label="Cluster context"]')?.value ?? ""`);
const remembered = (app) => app.profile.settings()?.windows ?? [];

/** Native titles of the app's X11 windows, sorted. */
function x11Titles(pid) {
  return x11Windows(pid)
    .map((id) => execFileSync("xprop", ["-id", id, "_NET_WM_NAME"], { encoding: "utf8" }).match(/= "(.*)"/)?.[1] ?? "")
    .sort();
}

/** WM_DELETE_WINDOW to the app's window titled `title` only. */
function closeTitled(pid, title) {
  const ids = x11Windows(pid).filter((id) =>
    execFileSync("xprop", ["-id", id, "_NET_WM_NAME"], { encoding: "utf8" }).includes(`"${title}"`),
  );
  assert.equal(ids.length, 1, `one window titled ${title}`);
  execFileSync("python3", [join(dirname(fileURLToPath(import.meta.url)), "../lib/wm-close.py"), ...ids], { stdio: "inherit" });
}

let kc;

describe("remembered windows across an exit", { timeout: 15 * 60_000, skip }, () => {
  after(() => kc?.remove());
  const s = appSession("windows-restore", () => {
    kc = aliasKubeconfig();
    return { kubeconfig: kc.path };
  });

  /** `win <alias>` in the palette; waits for the window and for settings.windows to list it. */
  async function openAliasWindow(app) {
    const main = await app.driver.getWindowHandle();
    const before = await windowHandles(app);
    await app.palette(`win ${kc.alias}`, kc.alias);
    await app.waitFor(async () => (await windowHandles(app)).length > before.length, { message: "a new window" });
    await app.waitFor(() => remembered(app).includes(kc.alias), { message: `${kc.alias} in settings.windows` });
    const pid = appPid(app.profile.home);
    await app.waitFor(() => JSON.stringify(x11Titles(pid)) === JSON.stringify([CONTEXT, kc.alias].sort()), {
      message: `windows titled ${CONTEXT} and ${kc.alias}`,
    });
    await switchTo(app, main);
  }

  it("closing the extra window alone forgets it", T, async () => {
    const { app } = s;
    await waitLive(app);
    await openAliasWindow(app);
    const pid = appPid(app.profile.home);
    closeTitled(pid, kc.alias);
    await app.waitFor(async () => (await windowHandles(app)).length === 1, { message: "one window left" });
    // Forgotten after a short delay (it would be kept if the app exited).
    await app.waitFor(() => remembered(app).length === 0, { message: "no extra window remembered" });
    assert.equal(await app.statusText(), "Live");
  });

  it("closing all windows at once (as on logout) reopens the extra one on its context", T, async () => {
    const { app } = s;
    await openAliasWindow(app);
    const pid = appPid(app.profile.home);
    console.log(`closing X11 windows ${closeLikeUser(pid).join(", ")} of pid ${pid}`);
    await app.waitFor(() => appPid(app.profile.home) === null, { timeout: 20_000, message: "the app to exit" });
    const after = remembered(app);
    console.log(`settings.windows after exit: ${JSON.stringify(after)}`);
    assert.deepEqual(after, [kc.alias]);

    await app.restart({ wait: 0 });
    await app.find(By.css("nav"));
    const handles = await app.waitFor(async () => {
      const h = await windowHandles(app);
      return h.length === 2 ? h : null;
    }, { message: "two windows after the restart" });
    const contexts = [];
    for (const h of handles) {
      await switchTo(app, h);
      await app.waitFor(() => contextValue(app), { message: "a context in the window" });
      contexts.push(await contextValue(app));
    }
    const titles = x11Titles(appPid(app.profile.home));
    console.log(`after the restart: contexts ${JSON.stringify(contexts)}, window titles ${JSON.stringify(titles)}`);
    assert.deepEqual([...contexts].sort(),[CONTEXT, kc.alias].sort());
    assert.deepEqual(titles, [CONTEXT, kc.alias].sort());
    // Screenshot the restored extra window.
    await switchTo(app, handles[contexts.indexOf(kc.alias)] ?? handles[1]);
    await waitLive(app);
  });
});
