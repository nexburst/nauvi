// Checks (#339): the log viewer's exclude box and context lines, and the
// header of a downloaded log, in WebKitGTK against kind.
// - Exclude hides the lines that match (grep -v), as new lines stream in.
// - "Context ±1" around the matches in filter mode: the lines before and
//   after each match, dimmed, with "--" between groups that are apart.
// - Download while filtering saves the lines shown, under a "# nauvi logs"
//   header naming the context, namespace, pod, container, time range and
//   filter.
// - Empty state (everything excluded) and an invalid exclude regex.
// Screenshots at 1280x800 in dark and light.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { logLines, logStatus, openPodLogs, pane } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };

// "req 7 status 200 ok" five times a second; every 6th says ERROR, every
// 3rd is a GET /health probe.
const POD = `
apiVersion: v1
kind: Pod
metadata:
  name: qa-grep
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
            m=ok; [ $((i % 3)) -eq 1 ] && m="GET /health"; [ $((i % 6)) -eq 0 ] && m=ERROR
            echo "req $i $m"
            i=$((i+1)); sleep 0.2
          done
`;

let ns;
const ID = () => `logs:${ns}/qa-grep`;

const button = (app, title) => app.find(By.css(`${pane(ID())} button[title=${JSON.stringify(title)}]`));
const filterBox = (app) => app.find(By.css(`${pane(ID())} input[aria-label="Filter logs"]`));
const excludeBox = (app) => app.find(By.css(`${pane(ID())} input[aria-label="Exclude lines"]`));

function text(app, testid) {
  return app.js(
    `return document.querySelector(arguments[0] + ' [data-testid="' + arguments[1] + '"]')?.textContent.trim() ?? ""`,
    pane(ID()),
    testid,
  );
}

/** The lines with their kind: "match", "context", "sep" or "line". */
function rows(app) {
  return app.js(
    `return Array.from(document.querySelectorAll(arguments[0] + ' [data-testid="log-line"]'), (l) => ({
       text: l.textContent,
       kind: l.classList.contains('sep') ? 'sep' : l.classList.contains('context') ? 'context' : l.querySelector('mark') ? 'match' : 'line',
     }));`,
    pane(ID()),
  );
}

/** The line count in the status ("1,234 lines"). */
async function statusCount(app) {
  const m = (await logStatus(app, ID())).match(/([\d,.   ]+)\+? lines/);
  return m ? Number(m[1].replace(/[^\d]/g, "")) : 0;
}

async function setContext(app, n) {
  await app.js(
    `const s = document.querySelector(arguments[0] + ' select[aria-label="Context lines"]');
     s.value = String(arguments[1]);
     s.dispatchEvent(new Event('change', { bubbles: true }));`,
    pane(ID()),
    n,
  );
}

async function shots(app, label) {
  await setTheme(app, "dark");
  await app.shot(`${label}-dark`);
  await setTheme(app, "light");
  await app.shot(`${label}-light`);
  await setTheme(app, null);
}

describe("log exclude and context (#339)", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-log-grep", POD);
    waitPodReady(ns, "qa-grep");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("log-exclude-context");

  it("exclude hides the matching lines as they stream in", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await openPodLogs(app, ns, "qa-grep");
    // The list is virtual: only the rows in view are rendered; count by the status.
    await app.waitFor(async () => (await statusCount(app)) >= 30, { timeout: 60_000, message: "30 lines" });
    await app.setValue(await excludeBox(app), "health");
    const last = (l) => Number(l.at(-1)?.match(/^req (\d+)/)?.[1] ?? -1);
    const first = await app.waitFor(
      async () => {
        const l = await logLines(app, ID());
        return l.length > 5 && l.every((x) => !x.includes("health")) ? l : null;
      },
      { message: "no health lines" },
    );
    // Still none a few seconds (and lines) later.
    await new Promise((r) => setTimeout(r, 3000));
    const later = await logLines(app, ID());
    assert.ok(last(later) > last(first), `more lines came: up to ${last(first)} -> ${last(later)}`);
    assert.ok(later.every((x) => !x.includes("health")), "no health line came in");
    console.log(`exclude: ${later.length} rows in view without "health", newest req ${last(later)}`);
    await shots(app, "exclude");
  });

  it("context lines around the matches, with -- between groups", T, async () => {
    const { app } = s;
    await app.setValue(await excludeBox(app), "");
    await app.setValue(await filterBox(app), "ERROR");
    await app.waitFor(async () => (await logLines(app, ID())).every((x) => x.includes("ERROR")), { message: "only ERROR lines" });
    await setContext(app, 1);
    const r = await app.waitFor(
      async () => {
        const r = await rows(app);
        return r.some((x) => x.kind === "context") && r.some((x) => x.kind === "sep") ? r : null;
      },
      { message: "context lines and separators" },
    );
    // Lines are "req N ...": a match N has N-1 before it and N+1 after it.
    const num = (t) => Number(t.match(/^req (\d+)/)?.[1]);
    for (let k = 0; k < r.length; k++) {
      if (r[k].kind !== "match") continue;
      const n = num(r[k].text);
      assert.ok(r[k].text.includes("ERROR"), r[k].text);
      if (k > 0 && r[k - 1].kind === "context") assert.equal(num(r[k - 1].text), n - 1, `before ${r[k].text}`);
      if (k + 1 < r.length && r[k + 1].kind === "context") assert.equal(num(r[k + 1].text), n + 1, `after ${r[k].text}`);
    }
    assert.ok(r.filter((x) => x.kind === "sep").every((x) => x.text === "--"));
    assert.ok(r.filter((x) => x.kind === "line").length === 0, "no other lines");
    console.log(`context ±1: ${r.length} rows, ${r.filter((x) => x.kind === "match").length} matches`);
    console.log(r.slice(0, 8).map((x) => `${x.kind}: ${x.text}`).join("\n"));
    await shots(app, "context");
  });

  it("Download while filtering saves the lines shown, under a header", T, async () => {
    const { app } = s;
    await app.setValue(await excludeBox(app), "req 0 ");
    await (await app.find(By.xpath(`//*[@data-tab='${ID()}']//button[normalize-space()='Download']`))).click();
    const path = await app.profile.waitForDownload(/^qa-grep_app_.*\.log$/);
    const content = readFileSync(path, "utf8");
    console.log(content.split("\n").slice(0, 16).join("\n"));
    const [header, body] = content.split("\n#\n");
    assert.match(header, /^# nauvi logs\n/);
    assert.match(header, new RegExp(`\\n# Context: +${CONTEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(header, new RegExp(`\\n# Namespace: +${ns}\\n`));
    assert.match(header, /\n# Pod: +qa-grep\n# Container: +app\n/);
    assert.match(header, /\n# Time range: +unknown/);
    assert.match(header, /\n# Filter: +match "ERROR" \(text, ignore case\), 1 line of context; exclude "req 0 "\n/);
    assert.match(header, /\n# Lines: +\d+ of \d+\n/);
    const lines = body.trimEnd().split("\n");
    assert.ok(lines.length > 3, `${lines.length} lines`);
    assert.ok(lines.every((l) => l === "--" || /^req \d+ /.test(l)), "only log lines and separators");
    assert.ok(lines.some((l) => l.includes("ERROR")) && lines.some((l) => !l.includes("ERROR") && l !== "--"), "matches and context");
    assert.ok(!lines.includes("req 0 ERROR"), "the excluded line is not saved");
  });

  it("Timestamps: the header gives the time range of the lines", T, async () => {
    const { app } = s;
    await app.setValue(await filterBox(app), "");
    await app.setValue(await excludeBox(app), "");
    await setContext(app, 0);
    await app.js(
      `const c = Array.from(document.querySelectorAll(arguments[0] + ' label.check')).find((l) => l.textContent.trim() === 'Timestamps').querySelector('input');
       c.click();`,
      pane(ID()),
    );
    await app.waitFor(async () => (await logLines(app, ID())).some((x) => /^\d{4}-\d\d-\d\dT/.test(x)), { message: "lines with a time" });
    const before = app.profile.downloadedFiles().length;
    await (await app.find(By.xpath(`//*[@data-tab='${ID()}']//button[normalize-space()='Download']`))).click();
    await app.waitFor(() => app.profile.downloadedFiles().length > before, { message: "a second download" });
    const name = app.profile.downloadedFiles().sort().at(-1);
    const content = readFileSync(`${app.profile.downloads}/${name}`, "utf8");
    console.log(content.split("\n").slice(0, 12).join("\n"));
    assert.match(content, /\n# Time range: +\d{4}-\d\d-\d\dT[\d:.]+Z to \d{4}-\d\d-\d\dT[\d:.]+Z\n/);
    assert.match(content, /\n# Filter: +none\n/);
  });

  it("empty and error states: everything excluded, an invalid exclude regex", T, async () => {
    const { app } = s;
    await app.setValue(await excludeBox(app), "req");
    await app.waitFor(async () => (await logLines(app, ID())).length === 0, { message: "no lines left" });
    await shots(app, "all-excluded");
    await (await button(app, "Regular expression")).click();
    await app.setValue(await excludeBox(app), "req (");
    const error = await app.waitFor(async () => text(app, "log-exclude-error"), { message: "the inline error" });
    console.log(`error: ${error}`);
    assert.match(error, /^Invalid exclude regex: /);
    assert.equal(await (await excludeBox(app)).getAttribute("aria-invalid"), "true");
    // The last good exclude ("req") stays.
    assert.equal((await logLines(app, ID())).length, 0);
    await shots(app, "invalid-exclude");
    await app.setValue(await excludeBox(app), "");
    await app.waitFor(async () => (await logLines(app, ID())).length > 0, { message: "lines back" });
  });
});
