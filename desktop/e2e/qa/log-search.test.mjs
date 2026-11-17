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

/** The line count in the status ("1,234 lines"; the list is virtual). */
async function statusCount(app, id) {
  const m = (await logStatus(app, id)).match(/([\d,.\u00a0\u202f ]+)\+? lines/);
  return m ? Number(m[1].replace(/[^\d]/g, "")) : 0;
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

/**
 * Frames per second over `ms`, the longest frame, and the dip: the fewest
 * frames in any 500 ms window, as frames per second (#272).
 */
function measureFps(app, ms = 2000) {
  return app.driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const times = []; const t0 = performance.now();
    function f(now) { times.push(now);
      if (now - t0 < ${ms}) { requestAnimationFrame(f); return; }
      let worst = 0; for (let i = 1; i < times.length; i++) worst = Math.max(worst, times[i] - times[i - 1]);
      let dip = Infinity; let j = 0;
      for (let i = 0; i < times.length; i++) {
        while (times[j] < times[i] - 500) j++;
        if (times[i] - t0 >= 500) dip = Math.min(dip, i - j + 1);
      }
      done({ fps: times.length / ((now - t0) / 1000), worst, dip: (dip === Infinity ? times.length : dip) * 2 }); }
    requestAnimationFrame(f);`);
}

const fpsLabel = (f) => `${f.fps.toFixed(1)} fps meanwhile (lowest 500 ms: ${f.dip} fps), worst frame ${f.worst.toFixed(0)} ms`;

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
    await app.waitFor(async () => (await statusCount(app, id)) >= 60, { timeout: 60_000, message: "60 lines" });
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
    // Wait for this search, not the one before it (the count says "N matches" for both).
    await app.waitFor(
      async () => {
        const marks = await app.js(`return Array.from(document.querySelectorAll(arguments[0] + ' [data-testid="log-line"] mark'), (m) => m.textContent);`, pane(id));
        return marks.length > 0 && marks.every((m) => /^error$/i.test(m)) ? marks : null;
      },
      { message: "the ERROR search applied" },
    );
    const total = await app.waitFor(
      async () => {
        const m = (await text(app, id, "log-match-count")).match(/^([\d,]+) match/);
        return m ? Number(m[1].replace(/,/g, "")) : null;
      },
      { message: '"N matches"' },
    );
    assert.ok(total >= 2, `${total} matches`);
    // The pod keeps logging, so the total grows: compare positions.
    const pos = async () => {
      const m = (await text(app, id, "log-match-count")).match(/^([\d,]+) of ([\d,]+)$/);
      return m ? { at: Number(m[1].replace(/,/g, "")), of: Number(m[2].replace(/,/g, "")) } : null;
    };
    const waitPos = (want, message) =>
      app.waitFor(async () => {
        const p = await pos();
        return p && want(p) ? p : null;
      }, { message });
    // From the top of the buffer: Enter goes to the first match in view.
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"] .scroller').scrollTop = 0`, pane(id));
    await input.sendKeys(Key.ENTER);
    await waitPos((p) => p.at === 1, '"1 of N"');
    const current = () =>
      app.js(
        `const l = document.querySelector(arguments[0] + ' [data-testid="log-line"].current');
         if (!l) return null;
         const r = l.getBoundingClientRect(); const o = document.querySelector(arguments[0] + ' [data-testid="log-output"]').getBoundingClientRect();
         return { text: l.textContent, inView: r.top >= o.top && r.bottom <= o.bottom };`,
        pane(id),
      );
    const first = await app.waitFor(current, { message: "the current match" });
    // Not match case: "error" lines count too.
    assert.ok(/error/i.test(first.text) && first.inView, JSON.stringify(first));
    await input.sendKeys(Key.ENTER);
    await waitPos((p) => p.at === 2, '"2 of N"');

    // n / N with the focus in the log output.
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"]').focus()`, pane(id));
    await app.driver.actions().sendKeys("N").perform();
    await waitPos((p) => p.at === 1, "N: back to 1");
    await app.driver.actions().sendKeys("N").perform();
    const last = await waitPos((p) => p.at > 2, "N wraps to the last");
    await app.driver.actions().sendKeys("n").perform();
    // To 1, unless a newer match came in meanwhile.
    const next = await waitPos((p) => p.at === 1 || p.at === last.at + 1, "n wraps to 1");
    await (await app.find(By.css(`${pane(id)} button[aria-label="Next match"]`))).click();
    await waitPos((p) => p.at === next.at + 1 || p.at === 1, "the ↓ button");
    const cur = await current();
    assert.ok(cur?.inView, `the current match is in view: ${JSON.stringify(cur)}`);
    console.log(`highlight: ${total} matches; current "${cur.text}"`);
    await shots(app, "highlight-current");

    // Off again: filtering.
    await (await button(app, id, HIGHLIGHT)).click();
    await app.waitFor(async () => (await logLines(app, id)).every((x) => /error/i.test(x)), { message: "filtering again" });
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
    await app.waitFor(async () => (await statusCount(app, id)) > 40 && (await logLines(app, id)).every((x) => /^\d{4}-/.test(x)), {
      timeout: 60_000,
      message: "timestamped lines",
    });
    // Aim between two lines in the middle of the buffer: the later one is the answer.
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"] .scroller').scrollTop = 0`, pane(id));
    const lines = await app.waitFor(async () => {
      const l = await logLines(app, id);
      return l.length > 12 ? l : null;
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
      // #272: the frame rate of the busy stream alone, to compare with.
      console.log(`busy stream, no search: ${fpsLabel(await measureFps(app, 2000))}`);
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
      console.log(`regex over the busy buffer: "${label}" in ${searchMs} ms; ${fpsLabel(fps)}`);
      assert.ok(searchMs < 15_000, `the search answered in ${searchMs} ms`);
      assert.ok(fps.fps >= 5, `the page kept drawing (${fps.fps.toFixed(1)} fps)`);
      // #272: a second search reads the worker's copy; nothing is sent again.
      // About one line in ten (the first matched one in a hundred).
      const t1b = Date.now();
      const fpsB = measureFps(app, 2000);
      await app.setValue(input, "req \\d+7 status");
      const label2 = await app.waitFor(
        async () => {
          const t = await text(app, sid, "log-match-count");
          const m = t.match(/^([\d,.   ]+) match/);
          return m && Number(m[1].replace(/[^\d]/g, "")) > 2000 ? t : null;
        },
        { timeout: 30_000, interval: 100, message: "the second search's count" },
      );
      const searchMs2 = Date.now() - t1b;
      console.log(`second regex over the busy buffer: "${label2}" in ${searchMs2} ms; ${fpsLabel(await fpsB)}`);
      // n / N start from the lines in view (the newest, following).
      await input.sendKeys(Key.SHIFT, Key.ENTER);
      const at = await app.waitFor(
        async () => {
          const m = (await text(app, sid, "log-match-count")).match(/^([\d,.\u00a0\u202f ]+) of /);
          return m ? m[1] : null;
        },
        { message: '"N of N"' },
      );
      console.log(`Shift+Enter went to match ${at}`);
      // #272: stepping turned Follow off, so the busy stream does not
      // scroll the match away (nor do trims of the oldest lines).
      const followBox = await app.find(By.xpath(`//*[@data-tab='${sid}']//label[normalize-space()='Follow']/input`));
      assert.equal(await followBox.isSelected(), false, "Follow is off after stepping");
      // Wait for a trim above the match (its number drops), not a fixed
      // time: the busy pod writes more than the 50,000-line buffer in about
      // 3 s on CI, after which the match itself is trimmed away (#317).
      const steppedTo = Number(at.replace(/[^\d]/g, ""));
      const after = await app.waitFor(
        async () => {
          const m = (await text(app, sid, "log-match-count")).match(/^([\d,.   ]+) of /);
          const n = m ? Number(m[1].replace(/[^\d]/g, "")) : NaN;
          return n < steppedTo ? n : null;
        },
        { timeout: 30_000, interval: 50, message: "a trim of the lines above the match" },
      );
      console.log(`after a trim the current match is ${after}`);
      const kept = await app.js(
        `const l = document.querySelector(arguments[0] + ' [data-testid="log-line"].current');
         if (!l) return null;
         const r = l.getBoundingClientRect(); const o = document.querySelector(arguments[0] + ' [data-testid="log-output"]').getBoundingClientRect();
         return { text: l.textContent, inView: r.top >= o.top - 1 && r.bottom <= o.bottom + 1 };`,
        pane(sid),
      );
      console.log(`after the trim the current match: ${JSON.stringify(kept)}`);
      assert.ok(kept?.inView, `the current match stays in view: ${JSON.stringify(kept)}`);
      await shots(app, "busy-highlight");
      await followBox.click();

      // `(a+)+$` on "aaa…a!" backtracks for ever: stopped after the limit.
      const t1 = Date.now();
      await app.setValue(input, "(a+)+$");
      const fps2P = measureFps(app, 2000);
      const err = await app.waitFor(async () => text(app, sid, "log-search-error"), { timeout: 30_000, interval: 100, message: '"Regex too slow"' });
      const stopMs = Date.now() - t1;
      const fps2 = await fps2P;
      console.log(`catastrophic regex: "${err}" after ${stopMs} ms; ${fpsLabel(fps2)}`);
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
