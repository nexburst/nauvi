// Helper: a fixed downloads dir (the profile's $HOME/Downloads,
// lib/profile.mjs).
// Check (#19): Download in a pod's log tab writes the log to ~/Downloads.
// Check (#178): the "Saved to Downloads/<file>" note stays while the pod
// keeps logging, on one line, without moving the log list (1280x800, dark
// and light), and goes by itself after 10 s.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, loggerPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };
let ns;

describe("log download", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-logs", loggerPodYaml("chatty"));
    waitPodReady(ns, "chatty");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("logs-download");

  it("Download saves the log lines to ~/Downloads", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "chatty");
    await (await app.find(By.xpath("//*[@data-testid='detail-panel']//button[normalize-space()='Logs']"))).click();
    const tab = `[data-testid="dock"] [data-tab="logs:${ns}/chatty"]`;
    await app.waitFor(async () => (await app.driver.findElements(By.css(`${tab} [data-testid="log-line"]`))).length >= 2, {
      message: "log lines in the dock tab",
    });
    await (await app.find(By.xpath(`//*[@data-tab='logs:${ns}/chatty']//button[normalize-space()='Download']`))).click();
    const path = await app.profile.waitForDownload(/^chatty_.*\.log$/);
    const text = readFileSync(path, "utf8");
    assert.match(text, /qa line 0/);
    // The page says where it went: "Saved to Downloads/<file>", the full
    // path in its tooltip (#178).
    const note = `${tab} [data-testid="log-saved"]`;
    const file = basename(path);
    await app.waitFor(async () => (await app.js(`return document.querySelector(arguments[0])?.textContent ?? ""`, note)) === `Saved to Downloads/${file}`, {
      message: `"Saved to Downloads/${file}"`,
    });
    assert.equal(await app.js(`return document.querySelector(arguments[0]).title`, note), path);
    console.log(`downloaded ${path}`);
    await app.shot("saved-note");
  });

  it("the note stays while lines stream in, on one line, at 1280x800 (#178)", T, async () => {
    const { app } = s;
    const tab = `[data-testid="dock"] [data-tab="logs:${ns}/chatty"]`;
    const note = `${tab} [data-testid="log-saved"]`;
    await resizeWindow(app, 1280, 800);
    const layout = () =>
      app.js(
        `const t = arguments[0];
         const h = document.querySelector(t + ' .logs-header').getBoundingClientRect();
         const o = document.querySelector(t + ' [data-testid="log-output"]').getBoundingClientRect();
         const n = document.querySelector(t + ' [data-testid="log-saved"]');
         return { headerH: Math.round(h.height), outputY: Math.round(o.top), note: n.textContent, noteH: Math.round(n.getBoundingClientRect().height),
                  lines: document.querySelectorAll(t + ' [data-testid="log-line"]').length };`,
        tab,
      );
    const before = await layout();
    await (await app.find(By.xpath(`//*[@data-tab='logs:${ns}/chatty']//button[normalize-space()='Download']`))).click();
    await app.waitFor(async () => (await layout()).note.startsWith("Saved to"), { message: "the saved note" });
    const shown = await layout();
    await app.shot("saved-note-1280-dark");
    // The pod writes a line a second: after 4 s new lines are in, and the note is still there.
    await new Promise((r) => setTimeout(r, 4000));
    const later = await layout();
    console.log(JSON.stringify({ before, shown, later }));
    assert.ok(later.lines > shown.lines || later.lines >= 5000, "new lines arrived meanwhile");
    assert.ok(later.note.startsWith("Saved to Downloads/"), `the note is still shown after 4 s: ${later.note}`);
    assert.equal(shown.headerH, before.headerH, "the header keeps its height");
    assert.equal(shown.outputY, before.outputY, "the log list does not move");
    assert.ok(shown.noteH <= 20, `the note is one line (${shown.noteH}px)`);
    await setTheme(app, "light");
    await app.shot("saved-note-1280-light");
    await setTheme(app, "dark");
    // And it goes away by itself (10 s).
    await app.waitFor(async () => (await app.js(`return document.querySelector(arguments[0])?.textContent ?? ""`, note)) === "", {
      timeout: 15_000,
      message: "the note to go after 10 s",
    });
  });
});
