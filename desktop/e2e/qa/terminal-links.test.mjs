// Helpers: the profile's xdg-open recorder (lib/profile.mjs), the terminal
// (lib/terminal.mjs).
// Checks (#245): OSC 8 hyperlinks printed by a pod's shell. A click on an
// http(s) link opens it in the browser through the opener (the recorded
// `xdg-open`); a `javascript:`, `file:` or custom-scheme link does nothing:
// no `window.open`, no prompt, no script, no navigation, nothing opened.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { panelButton } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOD = "http://example.com/kubeloupe-qa-245";
const BAD = [
  ["javascript:alert(document.domain)", "BADJSLINK"],
  ["file:///etc/passwd", "BADFILELINK"],
  ["vscode://file/etc/passwd", "BADSCHEMELINK"],
];

/** A shell command printing an OSC 8 link to `uri` that reads `text`. */
const printLink = (uri, text) => `printf '\\033]8;;${uri}\\007${text}\\033]8;;\\007\\n'`;

/** Record (instead of run) window.open, alert, confirm and prompt. */
const TRAP = `
  window.__qa245 = [];
  for (const name of ["open", "alert", "confirm", "prompt"]) {
    window[name] = (...args) => { window.__qa245.push(name + ": " + String(args[0])); return null; };
  }
  return location.href;`;

/**
 * Hover, then click the middle of `text` on the row that reads just `text`
 * (the output, not the echoed command line) in the visible terminal.
 */
async function clickText(app, text) {
  const rect = await app.waitFor(
    () =>
      app.js(
        `const text = arguments[0];
         const term = Array.from(document.querySelectorAll('[data-testid="terminal"]')).find((el) => el.offsetParent !== null);
         const rows = Array.from(term?.querySelector('.xterm-rows')?.children ?? []);
         const row = rows.find((r) => r.textContent.replace(/\u00a0/g, ' ').trim() === text);
         if (!row) return null;
         const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
         for (let n = walker.nextNode(); n; n = walker.nextNode()) {
           const i = n.textContent.indexOf(text);
           if (i < 0) continue;
           const range = document.createRange();
           range.setStart(n, i);
           range.setEnd(n, i + text.length);
           const r = range.getBoundingClientRect();
           return [r.x, r.y, r.width, r.height];
         }
         const r = row.getBoundingClientRect();
         return [r.x, r.y, Math.min(r.width, 40), r.height];`,
        text,
      ),
    { message: `${text} on the terminal's screen` },
  );
  const [x, y, w, h] = rect;
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  await app.driver
    .actions()
    .move({ origin: "viewport", x: cx - 3, y: cy })
    .pause(100)
    .move({ origin: "viewport", x: cx, y: cy })
    .pause(300)
    .click()
    .perform();
}

describe("terminal links", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-links", httpPodYaml("shell"));
    waitPodReady(ns, "shell");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("terminal-links");

  it("a javascript:, file: or custom-scheme link printed by a pod does nothing", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "shell");
    await panelButton(app, "Shell");
    const term = terminal(app);
    await term.waitForPrompt();
    await term.type("clear");
    for (const [uri, text] of BAD) await term.type(printLink(uri, text));
    await term.type(printLink(GOOD, "GOODLINK"));
    await term.waitFor(/^GOODLINK$/m);

    const href = await app.js(TRAP);
    for (const [, text] of BAD) await clickText(app, text);
    await sleep(1500);
    assert.deepEqual(await app.js("return window.__qa245"), [], "no window.open or prompt");
    assert.equal(await app.js("return location.href"), href, "the page did not navigate");
    assert.deepEqual(app.profile.opened(), [], "nothing was handed to xdg-open");
    // Still the app, and the shell still answers.
    assert.equal(await term.run("hostname"), "shell");
  });

  it("an http link printed by a pod opens in the browser", T, async () => {
    const { app } = s;
    await clickText(app, "GOODLINK");
    // The tooltip names the link's target, since its text can say anything.
    const title = await app.js(
      `const term = Array.from(document.querySelectorAll('[data-testid="terminal"]')).find((el) => el.offsetParent !== null);
       return term.querySelector('.screen').title;`,
    );
    assert.equal(title, GOOD);
    await app.waitFor(() => app.profile.opened().some((url) => url === GOOD), {
      timeout: 10_000,
      message: `${GOOD} to be opened (opened: ${app.profile.opened().join(", ")})`,
    });
    assert.deepEqual(app.profile.opened(), [GOOD], "only the http link was opened");
    assert.deepEqual(await app.js("return window.__qa245"), [], "not through window.open");
  });
});
