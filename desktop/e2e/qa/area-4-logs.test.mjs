// QA area 4 (#83): the pod log viewer in a dock tab.
// Checks (#19): the container picker marks init containers; Previous on a
// restarted pod; tail and since; Timestamps; Wrap on long lines; Follow on
// and off; Pause/Resume; Clear; the filter with highlights; with a busy pod
// the status reaches "50,000+ lines" and the UI stays responsive.
// Checks (#88): "All containers" on a pod with two regular containers merges
// them with a coloured `[container]` prefix, the filter matches the prefix,
// Previous is disabled, Download keeps the prefixes; a one-container pod is
// not offered it.
// Download itself (#19) is in logs-download.test.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { logLines, logStatus, openPodLogs, pane } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PODS = `
apiVersion: v1
kind: Pod
metadata:
  name: qa-area4-multi
spec:
  terminationGracePeriodSeconds: 0
  initContainers:
    - name: setup
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo init done"]
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command:
        - sh
        - -c
        - |
          L=$(head -c 600 /dev/zero | tr '\\0' x)
          i=0
          while true; do
            echo "app line $i"
            if [ $((i % 10)) -eq 0 ]; then echo "long $i $L end"; fi
            i=$((i+1)); sleep 0.2
          done
    - name: sidecar
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "i=0; while true; do echo side line $i; i=$((i+1)); sleep 1; done"]
---
apiVersion: v1
kind: Pod
metadata:
  name: qa-area4-restarter
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      # Exits once, then keeps running, so the previous run's logs stay
      # available. (Restarting every few seconds, the kubelet may already
      # have removed the run before; kubectl logs -p fails the same way.)
      command: ["sh", "-c", "echo boot $(cat /proc/sys/kernel/random/uuid); for i in 1 2 3; do echo tick $i; sleep 1; done; if [ -e /state/ran ]; then exec sleep 3600; fi; touch /state/ran; exit 1"]
      volumeMounts:
        - name: state
          mountPath: /state
  volumes:
    - name: state
      emptyDir: {}
`;

const SPAM = `
apiVersion: v1
kind: Pod
metadata:
  name: qa-area4-spam
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: spam
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "while true; do date; done"]
`;

let ns;
const MULTI = "qa-area4-multi";
const RESTARTER = "qa-area4-restarter";

/** Set a <select> or checkbox in a log tab the way the user would (fires `change`). */
async function setOption(app, id, title, value) {
  await app.js(
    `const s = document.querySelector(arguments[0] + ' select[title=' + JSON.stringify(arguments[1]) + ']');
     s.value = arguments[2];
     s.dispatchEvent(new Event("change", { bubbles: true }));`,
    pane(id),
    title,
    value,
  );
}

/** The checkbox labelled `label` in a log tab. */
async function checkbox(app, id, label) {
  return app.find(By.xpath(`//*[@data-tab='${id}']//label[normalize-space()='${label}']/input`));
}

/** The line count in the status ("1,234 lines"). */
async function statusCount(app, id) {
  const m = (await logStatus(app, id)).match(/([\d,]+)\+? lines/);
  return m ? Number(m[1].replace(/,/g, "")) : 0;
}

function scroller(app, id) {
  return app.js(
    `const s = document.querySelector(arguments[0] + ' [data-testid="log-output"] .scroller');
     return { top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight, width: s.scrollWidth, clientWidth: s.clientWidth };`,
    pane(id),
  );
}

describe("area 4: pod log viewer", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-area4-logs", PODS);
    waitPodReady(ns, MULTI);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("area-4-logs");
  let id;

  it("the container picker lists All containers, both containers and the init container marked", T, async () => {
    const { app } = s;
    await waitLive(app);
    id = await openPodLogs(app, ns, MULTI);
    const options = await app.waitFor(
      async () => {
        const o = await app.js(
          `return Array.from(document.querySelectorAll(arguments[0] + ' select[title="Container"] option'), (o) => [o.value, o.textContent.trim()]);`,
          pane(id),
        );
        return o.length >= 4 ? o : null;
      },
      { message: "four container options" },
    );
    console.log(`container options: ${JSON.stringify(options)}`);
    const labels = options.map((o) => o[1]);
    assert.ok(labels.includes("All containers"), labels.join(", "));
    assert.ok(labels.includes("app") && labels.includes("sidecar"), labels.join(", "));
    assert.ok(labels.includes("setup (init)"), labels.join(", "));
    const selected = await app.js(`return document.querySelector(arguments[0] + ' select[title="Container"]').value`, pane(id));
    assert.equal(selected, "app", "the first regular container is picked");
    await app.waitFor(async () => (await logLines(app, id)).some((l) => l.startsWith("app line")), {
      message: "app lines",
    });
  });

  it("the init container's logs", T, async () => {
    const { app } = s;
    await setOption(app, id, "Container", "setup");
    await app.waitFor(async () => (await logLines(app, id)).includes("init done"), { message: '"init done"' });
    await setOption(app, id, "Container", "app");
    await app.waitFor(async () => (await logLines(app, id)).some((l) => l.startsWith("app line")), { message: "app lines again" });
  });

  it("Timestamps prefixes each line with its time", T, async () => {
    const { app } = s;
    await (await checkbox(app, id, "Timestamps")).click();
    const lines = await app.waitFor(
      async () => {
        const l = await logLines(app, id);
        return l.length > 2 && l.every((x) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z /.test(x)) ? l : null;
      },
      { message: "timestamped lines" },
    );
    console.log(`with timestamps: ${lines.at(-1).slice(0, 80)}`);
    await (await checkbox(app, id, "Timestamps")).click();
    await app.waitFor(async () => (await logLines(app, id)).some((l) => l.startsWith("app line")), { message: "plain lines" });
  });

  it("tail 100 lines and since 5m restart the stream", T, async () => {
    const { app } = s;
    // The list is virtual: count lines from the status, not the DOM.
    // Enough lines for the tail to matter (5 per second plus long ones).
    await app.waitFor(async () => (await statusCount(app, id)) > 150, { timeout: 60_000, message: "> 150 lines" });
    await setOption(app, id, "Tail lines", "100");
    const n = await app.waitFor(
      async () => {
        const c = await statusCount(app, id);
        return c > 0 && c <= 110 ? c : null;
      },
      { message: "about 100 lines after tail 100" },
    );
    console.log(`tail 100: ${n} lines`);
    await setOption(app, id, "Since", "300");
    await app.waitFor(async () => (await logLines(app, id)).length > 0, { message: "lines since 5m" });
    await setOption(app, id, "Since", "all");
    await setOption(app, id, "Tail lines", "all");
    const all = await app.waitFor(async () => ((await statusCount(app, id)) > 150 ? statusCount(app, id) : null), {
      message: "all lines again",
    });
    // All lines start at the container's first line (scrolled to the top, Follow off).
    await (await checkbox(app, id, "Follow")).click();
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"] .scroller').scrollTop = 0`, pane(id));
    await app.waitFor(async () => (await logLines(app, id))[0] === "app line 0", { message: '"app line 0" at the top' });
    await (await checkbox(app, id, "Follow")).click();
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"] .scroller').scrollTop = 1e9`, pane(id));
    console.log(`all lines: ${all}`);
  });

  it("the filter shows matching lines with highlights", T, async () => {
    const { app } = s;
    const input = await app.find(By.css(`${pane(id)} input[type="search"]`));
    await app.setValue(input, "line 1");
    const lines = await app.waitFor(
      async () => {
        const l = await logLines(app, id);
        return l.length > 0 && l.every((x) => x.includes("line 1")) ? l : null;
      },
      { message: "only lines with 'line 1'" },
    );
    const marks = await app.js(
      `return Array.from(document.querySelectorAll(arguments[0] + ' [data-testid="log-line"] mark'), (m) => m.textContent);`,
      pane(id),
    );
    assert.ok(marks.length > 0 && marks.every((m) => m.toLowerCase() === "line 1"), JSON.stringify(marks.slice(0, 5)));
    console.log(`filter: ${lines.length} lines, ${marks.length} highlights`);
    await app.shot("filter-highlights");
    await app.setValue(input, "");
    await app.waitFor(async () => (await logLines(app, id)).some((l) => l.startsWith("long ")), { message: "unfiltered" });
  });

  it("Wrap breaks long lines; without it they scroll sideways", T, async () => {
    const { app } = s;
    const longLine = `Array.from(document.querySelectorAll(arguments[0] + ' [data-testid="log-line"]')).find((l) => l.textContent.startsWith('long '))`;
    const wrapBox = await checkbox(app, id, "Wrap");
    if (await wrapBox.isSelected()) await wrapBox.click();
    const off = await app.waitFor(() => app.js(`const l = ${longLine}; return l && { h: l.getBoundingClientRect().height };`, pane(id)), {
      message: "a long line",
    });
    const sc = await scroller(app, id);
    assert.ok(off.h <= 20, `one row high without wrap (${off.h}px)`);
    assert.ok(sc.width > sc.clientWidth, `horizontal scroll without wrap (${sc.width} > ${sc.clientWidth})`);
    await (await checkbox(app, id, "Wrap")).click();
    const on = await app.waitFor(
      () => app.js(`const l = ${longLine}; const h = l?.getBoundingClientRect().height; return h > 20 ? { h } : null;`, pane(id)),
      { message: "a wrapped long line" },
    );
    const sc2 = await scroller(app, id);
    assert.ok(sc2.width <= sc2.clientWidth + 1, `no horizontal scroll with wrap (${sc2.width} vs ${sc2.clientWidth})`);
    console.log(`long line: ${off.h}px unwrapped, ${on.h}px wrapped`);
    await app.shot("wrapped");
    await (await checkbox(app, id, "Wrap")).click();
  });

  it("Follow keeps the newest line in view; off, the view stays put", T, async () => {
    const { app } = s;
    const atBottom = (sc) => sc.height - sc.top - sc.client < 40;
    await app.waitFor(async () => atBottom(await scroller(app, id)), { message: "following at the bottom" });
    const before = await scroller(app, id);
    await sleep(2000);
    const later = await scroller(app, id);
    assert.ok(later.height > before.height && atBottom(later), "still at the bottom as lines arrive");
    await (await checkbox(app, id, "Follow")).click();
    await sleep(500);
    const fixed = await scroller(app, id);
    await sleep(3000);
    const after = await scroller(app, id);
    assert.ok(after.height > fixed.height, "lines keep arriving");
    assert.equal(after.top, fixed.top, "the scroll position does not move with Follow off");
    await (await checkbox(app, id, "Follow")).click();
    // Following again once back at the bottom.
    await app.js(`document.querySelector(arguments[0] + ' [data-testid="log-output"] .scroller').scrollTop = 1e9`, pane(id));
    await sleep(2000);
    assert.ok(atBottom(await scroller(app, id)), "at the bottom again");
  });

  it("Pause holds the view, Resume shows what came meanwhile; Clear empties it", T, async () => {
    const { app } = s;
    const button = (label) => app.find(By.xpath(`//*[@data-tab='${id}']//button[normalize-space()='${label}']`));
    await (await button("Pause")).click();
    await app.waitFor(async () => (await logStatus(app, id)).startsWith("paused"), { message: '"paused" status' });
    const shown = (await logLines(app, id)).length;
    const status1 = await logStatus(app, id);
    await sleep(3000);
    assert.equal((await logLines(app, id)).length, shown, "no new lines rendered while paused");
    const status2 = await logStatus(app, id);
    console.log(`paused: ${status1} -> ${status2}`);
    assert.notEqual(status1, status2, "the line count keeps counting while paused");
    await app.shot("paused");
    await (await button("Resume")).click();
    await app.waitFor(async () => (await logLines(app, id)).length > shown, { message: "lines after resume" });
    await (await button("Clear")).click();
    const cleared = (await logLines(app, id)).length;
    assert.ok(cleared <= 3, `cleared (${cleared} lines left)`);
    await app.waitFor(async () => (await logLines(app, id)).length > cleared, { message: "new lines after clear" });
  });

  it("All containers merges app and sidecar with coloured prefixes (#88)", T, async () => {
    const { app } = s;
    await setOption(app, id, "Container", "*");
    const prefixes = await app.waitFor(
      async () => {
        const p = await app.js(
          `return Array.from(document.querySelectorAll(arguments[0] + ' [data-testid="log-line"] .pod'), (s) => [s.textContent, getComputedStyle(s).color]);`,
          pane(id),
        );
        const names = new Set(p.map((x) => x[0]));
        return names.has("[app]") && names.has("[sidecar]") ? p : null;
      },
      { timeout: 30_000, message: "[app] and [sidecar] prefixes" },
    );
    const colors = new Map(prefixes.map(([n, c]) => [n, c]));
    console.log(`prefix colours: ${JSON.stringify([...colors])}`);
    assert.notEqual(colors.get("[app]"), colors.get("[sidecar]"), "each container has its own colour");
    assert.ok(!prefixes.some(([n]) => n.includes("setup")), "the init container is not followed");
    const previous = await checkbox(app, id, "Previous");
    assert.equal(await previous.isEnabled(), false, "Previous is disabled with All containers");
    // The filter matches the prefix too.
    const input = await app.find(By.css(`${pane(id)} input[type="search"]`));
    await app.setValue(input, "sidecar");
    await app.waitFor(
      async () => {
        const l = await logLines(app, id);
        return l.length > 0 && l.every((x) => x.startsWith("[sidecar]")) ? l : null;
      },
      { message: "only [sidecar] lines" },
    );
    await app.shot("all-containers-filtered");
    await app.setValue(input, "");
    await (await app.find(By.xpath(`//*[@data-tab='${id}']//button[normalize-space()='Download']`))).click();
    const path = await app.profile.waitForDownload(/^qa-area4-multi_all_.*\.log$/);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^\[app\] app line/m);
    assert.match(text, /^\[sidecar\] side line/m);
  });

  it("Previous shows the last run of a restarted container; no All containers for one container", T, async () => {
    const { app } = s;
    await app.waitFor(
      () => Number(kubectl(["-n", ns, "get", "pod", RESTARTER, "-o", "jsonpath={.status.containerStatuses[0].restartCount}"]) || 0) >= 1,
      { timeout: 120_000, interval: 2000, message: `${RESTARTER} restarted` },
    );
    const rid = await openPodLogs(app, ns, RESTARTER);
    const options = await app.js(
      `return Array.from(document.querySelectorAll(arguments[0] + ' select[title="Container"] option'), (o) => o.textContent.trim());`,
      pane(rid),
    );
    assert.deepEqual(options, ["app"], "one container, no All containers");
    const current = await app.waitFor(async () => (await logLines(app, rid)).find((l) => l.startsWith("boot ")), {
      message: "the current run's boot line",
    });
    await (await checkbox(app, rid, "Previous")).click();
    const prev = await app.waitFor(
      async () => {
        const l = await logLines(app, rid);
        const boot = l.find((x) => x.startsWith("boot "));
        return boot && boot !== current && l.includes("tick 3") ? { boot, l } : null;
      },
      { timeout: 30_000, message: "the previous run's lines (another boot id, up to tick 3)" },
    );
    console.log(`current: ${current}; previous: ${prev.boot}`);
    await app.shot("previous");
  });

  it("a busy pod reaches 50,000+ lines and the UI stays responsive", { timeout: 300_000 }, async () => {
    const { app } = s;
    kubectl(["-n", ns, "apply", "-f", "-"], SPAM);
    try {
      waitPodReady(ns, "qa-area4-spam");
      const sid = await openPodLogs(app, ns, "qa-area4-spam");
      const status = await app.waitFor(
        async () => {
          const st = await logStatus(app, sid);
          return (await statusCount(app, sid)) >= 50_000 && st.includes("+ lines") ? st : null;
        },
        { timeout: 180_000, interval: 1000, message: '"50,000+ lines"' },
      );
      // The label is the cap, not the buffer's length, which runs up to 10%
      // over it between trims (#113): sample it while lines keep coming.
      const samples = [status];
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 400));
        samples.push(await logStatus(app, sid));
      }
      console.log(`status samples: ${JSON.stringify(samples)}`);
      for (const st of samples) assert.match(st, /^(paused · )?50,000\+ lines$/, `status "${st}"`);
      // Frames per second over 2 s while the lines pour in.
      const fps = await app.driver.executeAsyncScript(`
        const done = arguments[arguments.length - 1];
        let n = 0; let worst = 0; let last = performance.now(); const t0 = last;
        function f(now) { n++; worst = Math.max(worst, now - last); last = now;
          if (now - t0 < 2000) requestAnimationFrame(f); else done({ fps: n / ((now - t0) / 1000), worst }); }
        requestAnimationFrame(f);`);
      // A click answers quickly: Pause flips the button.
      const t0 = Date.now();
      await (await app.find(By.xpath(`//*[@data-tab='${sid}']//button[normalize-space()='Pause']`))).click();
      await app.find(By.xpath(`//*[@data-tab='${sid}']//button[normalize-space()='Resume']`));
      const clickMs = Date.now() - t0;
      console.log(`status "${status}"; ${fps.fps.toFixed(1)} fps, worst frame ${fps.worst.toFixed(0)} ms; Pause answered in ${clickMs} ms`);
      await app.shot("busy-pod");
      assert.ok(fps.fps >= 10, `at least 10 fps while streaming (${fps.fps.toFixed(1)})`);
      assert.ok(clickMs < 3000, `Pause answered in under 3 s (${clickMs} ms)`);
    } finally {
      kubectl(["-n", ns, "delete", "pod", "qa-area4-spam", "--wait=false"]);
    }
  });
});
