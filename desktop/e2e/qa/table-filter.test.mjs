// Checks (#219): the table filter's toggles and saved searches, in WebKitGTK.
// - Plain text ignoring case is still the default; Aa (match case) and .*
//   (regex) narrow it; ^ and $ match per field.
// - An invalid regex shows inline, with the last good filter kept.
// - A regex that backtracks without end, `^(a+)+$`, is stopped in the
//   worker ("Regex too slow") and the page stays usable.
// - Searches are remembered (Enter), can be starred, are offered in another
//   list (ArrowDown), survive a restart, and settings.json holds only the
//   typed strings and toggles.
// Screenshots at 1280x800 in dark and light.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/theme.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces, tableData } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
// 34 a's and "-x": `^(a+)+$` backtracks on it for ever.
const SLOW = "a".repeat(34) + "-x";
const configMap = (name) => `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
data:
  k: v
`;
const OBJECTS = ["web-1", "web-22", "db-1", SLOW].map(configMap).join("");

let ns;

const names = async (app) => ((await tableData(app))?.rows ?? []).map((r) => r.Name).sort();
const errorText = (app) =>
  app.js(`return document.querySelector('[data-testid="table-filter-error"]')?.textContent.trim() ?? ""`);
const toggle = (app, label) => app.find(By.css(`button[aria-label="${label}"]`));
const pressed = async (app, label) => (await (await toggle(app, label)).getAttribute("aria-pressed")) === "true";
/** Turn a toggle on or off (whatever state an earlier test left it in). */
async function setToggle(app, label, on) {
  if ((await pressed(app, label)) !== on) await (await toggle(app, label)).click();
  await app.waitFor(async () => (await pressed(app, label)) === on, { message: `${label} ${on ? "on" : "off"}` });
}

/** Frames per second over `ms`, and the longest frame. */
function measureFps(app, ms = 2000) {
  return app.driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    let n = 0; let worst = 0; let last = performance.now(); const t0 = last;
    function f(now) { n++; worst = Math.max(worst, now - last); last = now;
      if (now - t0 < ${ms}) requestAnimationFrame(f); else done({ fps: n / ((now - t0) / 1000), worst }); }
    requestAnimationFrame(f);`);
}

const suggestionTexts = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[aria-label="Saved searches"] [role="option"]'), (o) => o.getAttribute("aria-label"));`);
const filterInput = (app) => app.find(By.css('input[aria-label="Filter"]'));

async function waitNames(app, want, message) {
  const w = [...want].sort();
  return app.waitFor(async () => JSON.stringify(await names(app)) === JSON.stringify(w), { message: `${message}: ${w.join(", ")}` });
}

/** Shots at 1280x800 in dark and light. */
async function shots(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

describe("table filter (#219)", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-table-filter", OBJECTS);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("table-filter");

  it("plain text ignoring case is the default; match case narrows it", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await app.nav("Config Maps");
    await pickNamespaces(app, [ns]);
    await waitNames(app, ["web-1", "web-22", "db-1", SLOW, "kube-root-ca.crt"], "every ConfigMap");
    assert.equal(await pressed(app, "Match case"), false);
    assert.equal(await pressed(app, "Regular expression"), false);

    await app.filter("WEB");
    await waitNames(app, ["web-1", "web-22"], "case ignored");
    // Regex characters are plain text by default.
    await app.filter("web-.");
    await waitNames(app, [], "no regex by default");
    await app.filter("WEB");
    await (await toggle(app, "Match case")).click();
    await waitNames(app, [], "match case: no upper-case WEB");
    await shots(app, "match-case-none");
    await (await toggle(app, "Match case")).click();
    await waitNames(app, ["web-1", "web-22"], "case ignored again");
  });

  it("a regex filters per field, in the worker", T, async () => {
    const { app } = s;
    await setToggle(app, "Regular expression", true);
    await app.filter("^web-\\d$");
    await waitNames(app, ["web-1"], "^web-\\d$");
    await app.filter("^(web|db)-1$");
    await waitNames(app, ["web-1", "db-1"], "^(web|db)-1$");
    const footer = await app.js(`return document.querySelector("footer")?.innerText ?? ""`);
    assert.match(footer, /2 of 5 items/);
    await shots(app, "regex");
  });

  it("an invalid regex shows inline and keeps the last good filter", T, async () => {
    const { app } = s;
    await app.filter("^(web|db)-(");
    const err = await app.waitFor(() => errorText(app), { message: "the inline error" });
    console.log(`invalid regex: ${err}`);
    assert.match(err, /^Invalid regex: /);
    assert.equal(await (await filterInput(app)).getAttribute("aria-invalid"), "true");
    const cut = await app.js(
      `const e = document.querySelector('[data-testid="table-filter-error"]'); return e.scrollWidth > e.clientWidth + 1;`,
    );
    assert.equal(cut, false, "the short error is shown whole");
    await waitNames(app, ["web-1", "db-1"], "the last good filter stays");
    await shots(app, "invalid-regex");
  });

  it("a catastrophic regex never blocks the page", T, async () => {
    const { app } = s;
    await setToggle(app, "Regular expression", true);
    // V8 backtracks on these for ever and the worker is stopped after the
    // limit ("Regex too slow"); JavaScriptCore may give up on its own and
    // report no match. Either way the page must keep drawing and answer.
    for (const pattern of ["^(a+)+$", "(a+)+$"]) {
      await app.filter("db-1");
      await setToggle(app, "Regular expression", false);
      await waitNames(app, ["db-1"], "a plain filter first");
      await setToggle(app, "Regular expression", true);
      const t0 = Date.now();
      await app.filter(pattern);
      const fpsP = measureFps(app, 2000);
      const outcome = await app.waitFor(
        async () => {
          const err = await errorText(app);
          if (/^Regex too slow/.test(err)) return `stopped: "${err}"`;
          if (err) throw new Error(`unexpected error: ${err}`);
          return (await names(app)).length === 0 ? "no match" : null;
        },
        { timeout: 30_000, interval: 100, message: "the slow regex to be stopped or to finish" },
      );
      // "No match" right away can also be the old matches being replaced: give the limit time.
      await new Promise((r) => setTimeout(r, 2500));
      const err = await errorText(app);
      const fps = await fpsP;
      console.log(
        `catastrophic ${pattern}: ${err ? `stopped: "${err}"` : outcome} after ${Date.now() - t0} ms; ${fps.fps.toFixed(1)} fps, worst frame ${fps.worst.toFixed(0)} ms`,
      );
      assert.deepEqual(await names(app), [], "the slow name does not match");
      assert.ok(fps.fps >= 5, `the page kept drawing (${fps.fps.toFixed(1)} fps)`);
      await shots(app, `catastrophic-${pattern.startsWith("^") ? "anchored" : "plain"}`);
      // The UI thread is free: a click answers at once.
      const t1 = Date.now();
      await setToggle(app, "Regular expression", false);
      const ms = Date.now() - t1;
      assert.ok(ms < 3000, `the toggle answered in ${ms} ms`);
      await app.waitFor(async () => (await errorText(app)) === "", { message: "the error goes" });
    }
  });

  it("searches are remembered, starred, offered in another list and kept across a restart", { timeout: 300_000 }, async () => {
    const { app } = s;
    await setToggle(app, "Match case", false);
    await setToggle(app, "Regular expression", true);
    const input = await filterInput(app);
    await app.filter("^web-\\d+$");
    await waitNames(app, ["web-1", "web-22"], "^web-\\d+$");
    await input.sendKeys(Key.ENTER);
    await (await app.find(By.css('button[aria-label="Star this search"]'))).click();
    await app.waitFor(
      async () => (await (await app.find(By.css('button[aria-label="Star this search"]'))).getAttribute("aria-pressed")) === "true",
      { message: "starred" },
    );
    // A plain one too.
    await setToggle(app, "Regular expression", false);
    await app.filter("db");
    await (await filterInput(app)).sendKeys(Key.ENTER);

    // Another list: the box emptied, ArrowDown offers both, starred first.
    await app.nav("Secrets");
    await app.filter("");
    await (await filterInput(app)).sendKeys(Key.ARROW_DOWN);
    const offered = await app.waitFor(async () => {
      const t = await suggestionTexts(app);
      return t.length >= 2 ? t : null;
    }, { message: "the saved searches" });
    console.log(`offered: ${JSON.stringify(offered)}`);
    assert.deepEqual(offered.slice(0, 2), ["/^web-\\d+$/ (starred)", "db"]);
    await shots(app, "suggestions");

    // Pick the starred one: back on ConfigMaps it filters with its regex.
    await (await filterInput(app)).sendKeys(Key.ENTER);
    assert.equal(await (await filterInput(app)).getAttribute("value"), "^web-\\d+$");
    assert.equal(await pressed(app, "Regular expression"), true);
    await app.nav("Config Maps");
    await waitNames(app, ["web-1", "web-22"], "the picked search filters");

    // Only the typed strings and toggles are in settings.json.
    await app.restart({ wait: 1500 });
    const saved = app.profile.settings()?.searches;
    console.log(`settings.searches: ${JSON.stringify(saved)}`);
    assert.deepEqual(saved?.starred, [{ text: "^web-\\d+$", regex: true, match_case: false }]);
    // Picking the starred one made it the newest recent search again.
    assert.deepEqual(
      saved?.recent.map((r) => r.text),
      ["^web-\\d+$", "db"],
    );
    for (const e of [...saved.recent, ...saved.starred]) assert.deepEqual(Object.keys(e).sort(), ["match_case", "regex", "text"]);

    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await app.nav("Pods");
    await (await filterInput(app)).click();
    await (await filterInput(app)).sendKeys(Key.ARROW_DOWN);
    const again = await app.waitFor(async () => {
      const t = await suggestionTexts(app);
      return t.length >= 2 ? t : null;
    }, { message: "the saved searches after a restart" });
    assert.deepEqual(again.slice(0, 2), ["/^web-\\d+$/ (starred)", "db"]);
    await shots(app, "after-restart");
    await (await filterInput(app)).sendKeys(Key.ESCAPE);
  });
});
