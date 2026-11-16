// Checks (#220): the log viewer's search in a dock tab, in WebKitGTK.
// - Match case (Aa) and regex (.*) toggles narrow the filter; the default
//   (case-insensitive text, filtering) is unchanged.
// - An invalid regex shows inline, with the last good search kept.
// - Highlight mode keeps every line; Enter, n / N and the arrows go through
//   the matches ("2 of 40"), the current one is marked.
// - Jump to time (Timestamps on) scrolls to the first line at or after it;
//   without timestamps it says to turn them on.
// - A busy pod (50,000+ lines): a regex over the whole buffer answers and
//   the page keeps its frame rate; a regex that backtracks without end,
//   `(a+)+$`, is stopped ("Regex too slow") and the page stays usable.
// Screenshots at 1280x800 in dark and light.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { logLines, logStatus, openPodLogs, pane } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };

// "req 7 status 200 ..." five times a second; every 10th is a 500, every
// 7th says ERROR and every 5th error (lower case).
const POD = `
apiVersion: v1
kind: Pod
metadata:
  name: qa-search
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command:
        - sh
        - -c
        - |
          i=0
          while true; do
            s=200; [ $((i % 10)) -eq 0 ] && s=500
            m=ok; [ $((i % 7)) -eq 0 ] && m=ERROR; [ $((i % 5)) -eq 0 ] && m=error
            echo "req $i status $s $m"
            i=$((i+1)); sleep 0.2
          done
`;

// As fast as it can: 50,000 lines in well under a minute. Each line ends
// in 30 a's and a "!", which `(a+)+$` backtracks on for ever.
const SPAM = `
apiVersion: v1
kind: Pod
metadata:
  name: qa-search-spam
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: spam
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command:
        - sh
        - -c
        - |
          i=0
          while true; do
            s=200; [ $((i % 100)) -eq 0 ] && s=503
            echo "req $i status $s aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"
            i=$((i+1))
          done
`;

let ns;

const button = (app, id, title) => app.find(By.css(`${pane(id)} button[title=${JSON.stringify(title)}]`));
const HIGHLIGHT = "Highlight the matches and keep the other lines, instead of filtering";

function text(app, id, testid) {
  return app.js(`return document.querySelector(arguments[0] + ' [data-testid="' + arguments[1] + '"]')?.textContent.trim() ?? ""`, pane(id), testid);
}

async function searchBox(app, id) {
  return app.find(By.css(`${pane(id)} input[type="search"]`));
}

/** Shots of the tab at 1280x800 in dark and light. */
async function shots(app, label) {
  await setTheme(app, "dark");
  await app.shot(`${label}-dark`);
  await setTheme(app, "light");
  await app.shot(`${label}-light`);
  await setTheme(app, null);
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

describe("log search (#220)", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-log-search", POD);
    waitPodReady(ns, "qa-search");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("log-search");
  let id;

  it("match case and regex narrow the filter; filtering stays the default", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    id = await openPodLogs(app, ns, "qa-search");
    await app.waitFor(async () => (await logLines(app, id)).length >= 40, { timeout: 60_000, message: "40 lines" });
    const input = await searchBox(app, id);

    await app.setValue(input, "error");
    const both = await app.waitFor(
      async () => {
        const l = await logLines(app, id);
        return l.length > 0 && l.every((x) => /error/i.test(x)) ? l : null;
      },
      { message: "only error / ERROR lines" },
    );
    assert.ok(both.some((l) => l.endsWith("ERROR")) && both.some((l) => l.endsWith("error")), "both cases");

    await (await button(app, id, "Match case")).click();
    await app.waitFor(async () => (await logLines(app, id)).every((x) => x.endsWith(" error")), { message: "lower-case error only" });

    await (await button(app, id, "Match case")).click();
    await (await button(app, id, "Regular expression")).click();
    await app.setValue(input, "status 5\\d\\d (ok|error)$");
    const lines = await app.waitFor(
      async () => {
        const l = await logLines(app, id);
        return l.length > 0 && l.every((x) => /status 500 (ok|error)$/.test(x)) ? l : null;
      },
      { message: "only 500 lines with ok or error" },
    );
    const marks = await app.js(
      `return Array.from(document.querySelectorAll(arguments[0] + ' [data-testid="log-line"] mark'), (m) => m.textContent);`,
      pane(id),
    );
    assert.ok(marks.length > 0 && marks.every((m) => /^status 500 (ok|error)$/.test(m)), JSON.stringify(marks.slice(0, 5)));
    console.log(`regex filter: ${lines.length} lines; count "${await text(app, id, "log-match-count")}"`);
    await shots(app, "regex-filter");
  });

  it("an invalid regex shows inline and keeps the last good search", T, async () => {
    const { app } = s;
    const input = await searchBox(app, id);
    const before = (await logLines(app, id)).length;
    await app.setValue(input, "status (5");
    const error = await app.waitFor(async () => text(app, id, "log-search-error"), { message: "the inline error" });
    console.log(`error: ${error}`);
    assert.match(error, /^Invalid regex: /);
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    const after = await logLines(app, id);
    assert.ok(after.length >= before && after.every((x) => / status 500 /.test(x)), "the last good filter stays");
    await shots(app, "invalid-regex");
    await app.setValue(input, "status (5)00");
    await app.waitFor(async () => (await text(app, id, "log-search-error")) === "", { message: "the error goes" });
  });

  it("highlight mode keeps every line; Enter, n / N and the arrows step through the matches", T, async () => {
    const { app } = s;
    const input = await searchBox(app, id);
    await (await button(app, id, HIGHLIGHT)).click();
    await app.setValue(input, "ERROR");
    await app.waitFor(async () => (await logLines(app, id)).some((x) => !x.includes("ERROR")), { message: "other lines shown too" });
    const total = await app.waitFor(
      async () => {
        const m = (await text(app, id, "log-match-count")).match(/^([\d,]+) match/);
        return m ? Number(m[1].replace(/,/g, "")) : null;
      },
      { message: '"N matches"' },
    );
    assert.ok(total >= 2, `${total} matches`);
    await input.sendKeys(Key.ENTER);
    await app.waitFor(async () => (await text(app, id, "log-match-count")) === `1 of ${total}`, { message: `"1 of ${total}"` });
    const current = () =>
      app.js(
        `const l = document.querySelector(arguments[0] + ' [data-testid="log-line"].current');
         if (!l) return null;
         const r = l.getBoundingClientRect(); const o = document.querySelector(arguments[0] + ' [data-testid="log-output"]').getBoundingClientRect();
         return { text: l.textContent, inView: r.top >= o.top && r.bottom <= o.bottom };`,
        pane(id),
      );
    const first = await app.waitFor(current, { message: "the current match" });
    assert.ok(first.text.includes("ERROR") && first.inView, JSON.stringify(first));
    await input.sendKeys(Key.ENTER);
    await app.waitFor(async () => (await text(app, id, "log-match-count")) === `2 of ${total}`, { message: `"2 of ${total}"` });

    // n / N with the focus in the log output.
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"]').focus()`, pane(id));
    await app.driver.actions().sendKeys("N").perform();
    await app.waitFor(async () => (await text(app, id, "log-match-count")) === `1 of ${total}`, { message: "N: back to 1" });
    await app.driver.actions().sendKeys("N").perform();
    await app.waitFor(async () => (await text(app, id, "log-match-count")).endsWith(` of ${total}`) && !(await text(app, id, "log-match-count")).startsWith("1 "), {
      message: "N wraps to the last",
    });
    await app.driver.actions().sendKeys("n").perform();
    await app.waitFor(async () => (await text(app, id, "log-match-count")) === `1 of ${total}`, { message: "n wraps to 1" });
    await (await app.find(By.css(`${pane(id)} button[aria-label="Next match"]`))).click();
    await app.waitFor(async () => (await text(app, id, "log-match-count")) === `2 of ${total}`, { message: "the ↓ button" });
    const cur = await current();
    assert.ok(cur?.inView, `the current match is in view: ${JSON.stringify(cur)}`);
    console.log(`highlight: ${total} matches; current "${cur.text}"`);
    await shots(app, "highlight-current");

    // Off again: filtering.
    await (await button(app, id, HIGHLIGHT)).click();
    await app.waitFor(async () => (await logLines(app, id)).every((x) => x.includes("ERROR")), { message: "filtering again" });
    await app.setValue(input, "");
    await (await button(app, id, "Regular expression")).click();
  });

  it("Jump to time goes to the first line at or after it; without timestamps it says so", T, async () => {
    const { app } = s;
    const jump = await app.find(By.css(`${pane(id)} input[aria-label="Jump to time"]`));
    await app.setValue(jump, "10:00");
    await jump.sendKeys(Key.ENTER);
    const note = await app.waitFor(async () => text(app, id, "log-jump-note"), { message: "the no-timestamps note" });
    assert.equal(note, "The lines have no time: turn on Timestamps");
    await shots(app, "jump-no-timestamps");

    await (await app.find(By.xpath(`//*[@data-tab='${id}']//label[normalize-space()='Timestamps']/input`))).click();
    await app.waitFor(async () => (await logLines(app, id)).length > 40 && (await logLines(app, id)).every((x) => /^\d{4}-/.test(x)), {
      timeout: 60_000,
      message: "timestamped lines",
    });
    // Aim between two lines in the middle of the buffer: the later one is the answer.
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"] .scroller').scrollTop = 0`, pane(id));
    const lines = await app.waitFor(async () => {
      const l = await logLines(app, id);
      return l.length > 30 ? l : null;
    });
    const a = lines[10].split(" ")[0];
    const b = lines[11].split(" ")[0];
    // Millisecond precision is enough: the lines are 200 ms apart.
    const ms = (t) => Date.parse(t.slice(0, 23) + "Z");
    const mid = new Date((ms(a) + ms(b)) / 2).toISOString();
    // Scroll away (the bottom), then jump.
    await (await app.find(By.xpath(`//*[@data-tab='${id}']//label[normalize-space()='Follow']/input`))).click();
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"] .scroller').scrollTop = 1e9`, pane(id));
    await app.setValue(jump, mid);
    await (await app.find(By.xpath(`//*[@data-tab='${id}']//form//button[normalize-space()='Go']`))).click();
    const jumped = await app.waitFor(
      () =>
        app.js(
          `const l = document.querySelector(arguments[0] + ' [data-testid="log-line"].jumped');
           if (!l) return null;
           const r = l.getBoundingClientRect(); const o = document.querySelector(arguments[0] + ' [data-testid="log-output"]').getBoundingClientRect();
           return { text: l.textContent, inView: r.top >= o.top - 1 && r.bottom <= o.bottom + 1 };`,
          pane(id),
        ),
      { message: "the jumped-to line" },
    );
    console.log(`jump to ${mid}: ${jumped.text}`);
    assert.ok(jumped.text.startsWith(b), `the first line at or after ${mid} (${b}): ${jumped.text}`);
    assert.ok(jumped.inView, "in view");
    assert.equal(await text(app, id, "log-jump-note"), "");
    await shots(app, "jumped");
    await (await app.find(By.xpath(`//*[@data-tab='${id}']//label[normalize-space()='Follow']/input`))).click();
  });

  it("a busy pod: a regex over 50,000+ lines answers, a catastrophic one is stopped, the page stays usable", { timeout: 360_000 }, async () => {
    const { app } = s;
    kubectl(["-n", ns, "apply", "-f", "-"], SPAM);
    try {
      waitPodReady(ns, "qa-search-spam");
      const sid = await openPodLogs(app, ns, "qa-search-spam");
      await app.waitFor(async () => (await logStatus(app, sid)).includes("+ lines"), {
        timeout: 180_000,
        interval: 1000,
        message: '"50,000+ lines"',
      });
      await (await button(app, sid, "Regular expression")).click();
      await (await button(app, sid, HIGHLIGHT)).click();
      const input = await searchBox(app, sid);
      const t0 = Date.now();
      await app.setValue(input, "status 50\\d a+!$");
      const fpsP = measureFps(app, 2000);
      const label = await app.waitFor(
        async () => {
          const t = await text(app, sid, "log-match-count");
          return /^[\d,.   ]+ match/.test(t) && !/^0 /.test(t) ? t : null;
        },
        { timeout: 30_000, interval: 100, message: "the match count" },
      );
      const searchMs = Date.now() - t0;
      const fps = await fpsP;
      console.log(`regex over the busy buffer: "${label}" in ${searchMs} ms; ${fps.fps.toFixed(1)} fps meanwhile, worst frame ${fps.worst.toFixed(0)} ms`);
      assert.ok(searchMs < 15_000, `the search answered in ${searchMs} ms`);
      assert.ok(fps.fps >= 5, `the page kept drawing (${fps.fps.toFixed(1)} fps)`);
      await input.sendKeys(Key.ENTER);
      await app.waitFor(async () => /^1 of /.test(await text(app, sid, "log-match-count")), { message: '"1 of N"' });
      await shots(app, "busy-highlight");

      // `(a+)+$` on "aaa…a!" backtracks for ever: stopped after the limit.
      const t1 = Date.now();
      await app.setValue(input, "(a+)+$");
      const fps2P = measureFps(app, 2000);
      const err = await app.waitFor(async () => text(app, sid, "log-search-error"), { timeout: 30_000, interval: 100, message: '"Regex too slow"' });
      const stopMs = Date.now() - t1;
      const fps2 = await fps2P;
      console.log(`catastrophic regex: "${err}" after ${stopMs} ms; ${fps2.fps.toFixed(1)} fps meanwhile, worst frame ${fps2.worst.toFixed(0)} ms`);
      assert.match(err, /^Regex too slow/);
      assert.ok(fps2.fps >= 5, `the page kept drawing while the regex ran (${fps2.fps.toFixed(1)} fps)`);
      // Still usable: Pause answers, and a new search works.
      const t2 = Date.now();
      await (await app.find(By.xpath(`//*[@data-tab='${sid}']//button[normalize-space()='Pause']`))).click();
      await app.find(By.xpath(`//*[@data-tab='${sid}']//button[normalize-space()='Resume']`));
      const clickMs = Date.now() - t2;
      assert.ok(clickMs < 3000, `Pause answered in ${clickMs} ms`);
      await shots(app, "busy-too-slow");
      await app.setValue(input, "status 503");
      await app.waitFor(async () => (await text(app, sid, "log-search-error")) === "" && /match/.test(await text(app, sid, "log-match-count")), {
        timeout: 30_000,
        message: "a new search after the slow one",
      });
      await (await app.find(By.xpath(`//*[@data-tab='${sid}']//button[normalize-space()='Resume']`))).click();
    } finally {
      kubectl(["-n", ns, "delete", "pod", "qa-search-spam", "--wait=false"]);
    }
  });
});
