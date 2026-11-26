// Checks (#492, #493): the log tab at 1280x800 with the pod's panel open,
// and "Previous" on a crash-looping pod, in WebKitGTK against kind.
// - One toolbar row under the context line, no second heading, and at
//   least 12 log lines in view; the Options menu holds the rest.
// - Previous on a crash-looping pod: the context line names the previous
//   run and its exit code, Follow is off and disabled, the log ends with
//   "[end of the previous run]".
// - A restarted container that has not logged yet offers the run that
//   crashed; the offer switches to Previous.
// - Previous on a container that never restarted: a plain sentence, not the
//   API server's error.
// Screenshots at 1280x800 in dark and light.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { followButton, logLines, logStatus, openLogOptions, openPodLogs, pane } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 240_000 };

const pod = (name, script) => `
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: worker
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", ${JSON.stringify(script)}]
`;

// A line five times a second, with an ERROR now and then.
const CHATTY = pod("qa-chatty", 'i=0; while true; do m=ok; [ $((i % 7)) -eq 0 ] && m="ERROR payment timeout"; echo "req $i $m"; i=$((i+1)); sleep 0.2; done');
// Logs, then crashes with code 1 after 3 s: CrashLoopBackOff.
const CRASH = pod("qa-crash", 'echo "starting run at $(date +%T)"; echo "connecting to db:5432"; sleep 3; echo "FATAL: could not connect to database" >&2; exit 1');
// Silent for 40 s, then crashes: each new run has a quiet start.
const QUIET = pod("qa-quiet", 'sleep 40; echo "FATAL: gave up at $(date +%T)" >&2; exit 1');

let ns;

/** The pod's restart count and its container's state ("running", "waiting", …). */
function status(name) {
  const out = kubectl([
    "-n",
    ns,
    "get",
    "pod",
    name,
    "-o",
    "jsonpath={.status.containerStatuses[0].restartCount} {.status.containerStatuses[0].state}",
  ]);
  const [restarts, ...state] = out.trim().split(" ");
  return { restarts: Number(restarts) || 0, state: state.join(" ") };
}

async function waitFor(check, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function contextLine(app, id) {
  return app.js(
    `return document.querySelector(arguments[0] + ' [data-testid="dock-context"]')?.textContent.trim() ?? ""`,
    pane(id),
  );
}

async function shots(app, label) {
  await setTheme(app, "dark");
  await app.shot(`${label}-dark`);
  await setTheme(app, "light");
  await app.shot(`${label}-light`);
  await setTheme(app, null);
}

async function previousBox(app, id) {
  return app.find(By.xpath(`//*[@data-tab='${id}']//label[normalize-space()='Previous']/input`));
}

describe("log dock layout and Previous (#492, #493)", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-log-dock", CHATTY + "---\n" + CRASH + "---\n" + QUIET);
    waitPodReady(ns, "qa-chatty");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("log-dock");

  it("at 1280x800 with the panel open: one toolbar row and at least 12 lines", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    const id = await openPodLogs(app, ns, "qa-chatty");
    await app.waitFor(async () => (await logLines(app, id)).length >= 20, { timeout: 60_000, message: "20 lines" });
    const m = await app.js(
      `const p = document.querySelector(arguments[0]);
       const bar = p.querySelector('[data-testid="log-toolbar"]').getBoundingClientRect();
       const out = p.querySelector('[data-testid="log-output"]').getBoundingClientRect();
       const inView = Array.from(p.querySelectorAll('[data-testid="log-line"]')).filter((l) => {
         const r = l.getBoundingClientRect();
         return r.top >= out.top - 1 && r.bottom <= out.bottom + 1;
       }).length;
       return { bar: bar.height, out: out.height, inView, h3: p.querySelectorAll('h3').length,
                panel: !!document.querySelector('[data-testid="detail-panel"]') };`,
      pane(id),
    );
    console.log(`toolbar ${m.bar}px, output ${m.out}px, ${m.inView} lines in view, panel open: ${m.panel}`);
    assert.ok(m.panel, "the pod's panel is still open");
    assert.ok(m.bar < 48, `one toolbar row (${m.bar}px)`);
    assert.equal(m.h3, 0, "no second heading");
    assert.ok(m.inView >= 12, `at least 12 lines in view (${m.inView})`);
    await shots(app, "logs-1280");

    // A search, then the Options menu.
    const filter = await app.find(By.css(`${pane(id)} input[aria-label="Filter logs"]`));
    await app.setValue(filter, "ERROR");
    await app.waitFor(async () => (await logLines(app, id)).every((l) => l.includes("ERROR")), { message: "filtered" });
    await shots(app, "logs-filtered");
    await openLogOptions(app, id);
    await shots(app, "logs-options");
    await app.setValue(filter, "");
  });

  it("Previous on a crash-looping pod names the previous run and its exit code", T, async () => {
    const { app } = s;
    await waitFor(() => status("qa-crash").restarts >= 2, 180_000, "qa-crash to restart twice");
    const id = await openPodLogs(app, ns, "qa-crash");
    await app.waitFor(async () => (await logLines(app, id)).length > 0, { timeout: 30_000, message: "lines" });
    console.log(`current: "${await contextLine(app, id)}"`);
    await shots(app, "crash-current");

    await (await previousBox(app, id)).click();
    const line = await app.waitFor(
      async () => {
        const t = await contextLine(app, id);
        return /previous run, exited with code 1/.test(t) ? t : null;
      },
      { timeout: 30_000, message: "the context line naming the previous run" },
    );
    console.log(`previous: "${line}"`);
    const follow = await followButton(app, id);
    assert.equal(await follow.isEnabled(), false, "Follow is disabled for a finished run");
    await app.waitFor(
      async () => {
        const l = await logLines(app, id);
        return l.at(-1) === "[end of the previous run]" || /no longer on the node/.test(l.join("\n")) ? l : null;
      },
      { timeout: 30_000, message: "the previous run's log, read whole" },
    );
    const lines = await logLines(app, id);
    console.log(`previous run: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => l.includes("unable to retrieve container logs")), "no raw runtime error");
    assert.ok(!/\b1 lines\b/.test(await logStatus(app, id)), "1 line, not 1 lines");
    await shots(app, "crash-previous");
  });

  it("a restarted container that has not logged yet offers the run that crashed", T, async () => {
    const { app } = s;
    await waitFor(
      () => {
        const st = status("qa-quiet");
        return st.restarts >= 1 && st.state.includes("running");
      },
      200_000,
      "qa-quiet running again after a crash",
    );
    const id = await openPodLogs(app, ns, "qa-quiet");
    const offer = await app.find(By.css(`${pane(id)} [data-testid="log-offer"]`), { timeout: 15_000 });
    console.log(`offer: "${(await offer.getText()).trim()}" / "${await contextLine(app, id)}"`);
    await shots(app, "quiet-offer");
    await (await offer.findElement(By.css("button"))).click();
    const line = await app.waitFor(
      async () => {
        const t = await contextLine(app, id);
        return /previous run, exited with code 1/.test(t) ? t : null;
      },
      { timeout: 30_000, message: "Previous on" },
    );
    assert.equal(await (await previousBox(app, id)).isSelected(), true, "Previous is ticked");
    await app.waitFor(async () => (await logLines(app, id)).some((l) => l.startsWith("FATAL: gave up")), {
      timeout: 30_000,
      message: "the crashed run's line",
    });
    console.log(`after the offer: "${line}"`);
    await shots(app, "quiet-previous");
  });

  it("Previous on a container that never restarted says so in words", T, async () => {
    const { app } = s;
    const id = await openPodLogs(app, ns, "qa-chatty");
    await (await previousBox(app, id)).click();
    const l = await app.waitFor(
      async () => {
        const lines = await logLines(app, id);
        return lines.some((x) => x.includes("no previous run")) ? lines : null;
      },
      { timeout: 30_000, message: "the no-previous-run sentence" },
    );
    console.log(`never restarted: ${JSON.stringify(l)}`);
    assert.ok(l.includes("This container has no previous run: it has not restarted since the pod started."));
    assert.match(await contextLine(app, id), /previous run \(it has not restarted\)/);
    await shots(app, "no-previous");
    await (await previousBox(app, id)).click();
  });
});
