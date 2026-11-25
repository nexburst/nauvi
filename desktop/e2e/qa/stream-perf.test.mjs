// Stream throughput in the real app (#115): how long the UI takes to show
//   - a burst of 50k log lines in a pod's log tab,
//   - 10 MB printed in a pod terminal, and in a local shell (no cluster in
//     the way: only the app's part), with how long key presses take to be
//     handled while it floods,
//   - the first snapshot of a watch of 5k pods, and the incremental
//     batches while 1k of them are deleted,
//   - saving the 50k lines (Download), and loading the YAML of a ConfigMap
//     of about 900 KB (Reload in its YAML tab),
// with the frame times of the page, the CPU time of the core and of the
// WebKitWebProcess, and their peak memory.
//
// The numbers go to the console, artifacts/stream-perf.json and, on GitHub
// Actions, the job summary. The log burst, the two terminals and the watch
// snapshot have budgets (LOG_BUDGET, TERM_BUDGET, WATCH_BUDGET, per build);
// the watch updates, the log download and the YAML are report-only.
// QA_PERF_BUDGET=off turns them off.
//
// qa.yml builds a release binary when idle-memory runs; with
// QA_RELEASE_APP set this scenario measures it too (run it as
// `-f scenario='stream-perf idle-memory'`), else the debug build.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, CONTEXT, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appPid, openPodLogs, pane, panelButton } from "../lib/dock.mjs";
import { measured, peakMemory } from "../lib/perf.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { terminal } from "../lib/terminal.mjs";
import { resizeWindow } from "../lib/window.mjs";

const RELEASE = process.env.QA_RELEASE_APP && existsSync(process.env.QA_RELEASE_APP);
if (RELEASE) process.env.NAUVI_APP = resolve(process.env.QA_RELEASE_APP);
const BUILD = RELEASE ? "release" : "debug";

const LOG_LINES = 50_000;
const TERM_BYTES = 10 * 1024 * 1024;
const PODS = Number(process.env.QA_PERF_PODS || 5000);
/** Pods deleted while the table watches, for its incremental batches. */
const CHURN = Math.floor(PODS / 5);

/** Log bursts measured; the median one is reported and checked. */
const BURSTS = 3;
/** Downloads and YAML reloads measured; the median one is reported. */
const REPEATS = 3;
/** Lines of 100 bytes in the big ConfigMap (about 900 KB, under the 1 MiB limit). */
const YAML_LINES = 9000;

/**
 * The 50k-line burst (median of BURSTS). Release, on qa.yml runners (#115):
 * 0.7-1.7 s, frame p95 30-60 ms, core 0.2-0.55 s and web 0.6-1.6 s CPU,
 * 420-450 MB RSS; runners differ a lot (`kubectl logs` of the same pod took
 * 0.3 s on one, 2.8 s on another), so the limits leave about 3x over the
 * slow one. Debug: a loaded 4-core dev box showed 3-5 s, p95 90-125 ms,
 * 4 s CPU each, 600 MB.
 */
const LOG_BUDGET = RELEASE
  ? { ms: 6000, p95Frame: 200, coreCpuS: 2, webCpuS: 5, coreAndWebRssMb: 900 }
  : { ms: 20_000, p95Frame: 400, coreCpuS: 12, webCpuS: 15, coreAndWebRssMb: 1200 };

/**
 * 10 MB in a terminal, pod or local. What the app's part costs: frames and
 * CPU, not the time until shown (that is the cluster's pace for a pod).
 * Release on a qa.yml runner (#115): pod p95 28 ms, 13.5% frame time lost,
 * core 0.4 s, web 1.3 s CPU; local p95 15 ms, 1% lost (the old global
 * events: p95 40-125 ms, 27-75% lost). The limits leave room for slow
 * runners but fail what the old path did on one (59% lost). A pod's flood
 * goes at the cluster's pace (4.5 s where `kubectl logs` took 2.9 s), and
 * the page's CPU grows with the time drawn: its web CPU limit is higher
 * (4.4 s seen on that slow runner).
 */
const TERM_BUDGET = RELEASE
  ? { p95Frame: 100, blockedPct: 40, coreCpuS: 2, webCpuS: 4 }
  : { p95Frame: 300, blockedPct: 80, coreCpuS: 12, webCpuS: 15 };
const POD_TERM_BUDGET = { ...TERM_BUDGET, webCpuS: RELEASE ? 6 : 20 };

/**
 * `yes` in a local shell, faster than the screen can draw: past the
 * backend's window and queue the oldest output is dropped and
 * "[… N MB of output skipped]" shows; memory stays bounded. After YES_MS,
 * Ctrl-C drops the backlog ("… skipped at Ctrl-C") and the next command's
 * output shows within about a second.
 */
const YES_MS = 5000;
const YES_BUDGET = RELEASE
  ? { promptMs: 1500, coreAndWebRssMb: 900 }
  : { promptMs: 5000, coreAndWebRssMb: 1200 };

/**
 * The first snapshot of a watch of PODS pods. Release, qa.yml runners
 * (#115): 0.4-0.7 s, frame p95 16 ms, core and web 0.25 s CPU each, peak
 * RSS core 180-340 MB and web 360-375 MB. The limits leave about 4x over
 * that. Debug, a loaded dev box: about 3 s.
 */
const WATCH_BUDGET = RELEASE
  ? { ms: 3000, p95Frame: 150, coreCpuS: 2, webCpuS: 2, coreAndWebRssMb: 1200 }
  : { ms: 15_000, p95Frame: 400, coreCpuS: 15, webCpuS: 10, coreAndWebRssMb: 1800 };

/** The keys `over` its budget, as "key value > limit" (none: budgets off). */
function overBudget(r, budget) {
  if (process.env.QA_PERF_BUDGET === "off") return [];
  return Object.entries(budget)
    .filter(([k, limit]) => r[k] > limit)
    .map(([k, limit]) => `${k} ${r[k]} > ${limit}`);
}

/** The command that prints TERM_BYTES and then `marker`, which the command line itself does not show. */
const floodCommand = (marker) =>
  `head -c ${TERM_BYTES} /dev/zero | tr '\\0' x | fold -w 100; echo ${marker}$((40+2))`;

const skip = process.platform !== "linux" ? "reads /proc (Linux only)" : false;
const T = { timeout: 300_000 };
const results = { build: BUILD };

/** A pod that logs "ready", then prints LOG_LINES lines at once each time /tmp/go<n> appears (n = 1, 2, ...). */
function burstPodYaml(name) {
  const line = "burst line & lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor";
  return `
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo ready; i=1; while true; do while [ ! -f /tmp/go$i ]; do sleep 0.1; done; seq 1 ${LOG_LINES} | sed 's/.*/${line}/'; echo BURST-END-$i; i=$((i+1)); done"]
`;
}

/** `kubectl create` the pods in parallel chunks (one process each). */
async function createPods(namespace, count, chunks = 8) {
  const pod = (i) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `w-${String(i).padStart(5, "0")}`,
      labels: { app: "qa-watch", churn: i < CHURN ? "yes" : "no" },
    },
    // Gated: never scheduled, so no node runs them (#115 only watches them).
    spec: { schedulingGates: [{ name: "nauvi.qa/hold" }], containers: [{ name: "c", image: "busybox:1.36" }] },
  });
  const per = Math.ceil(count / chunks);
  await Promise.all(
    Array.from({ length: chunks }, (_, c) => {
      const items = [];
      for (let i = c * per; i < Math.min(count, (c + 1) * per); i++) items.push(pod(i));
      return new Promise((done, fail) => {
        const p = spawn("kubectl", ["--context", CONTEXT, "-n", namespace, "create", "-f", "-", "-o", "name"], {
          stdio: ["pipe", "ignore", "pipe"],
        });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("exit", (code) => (code === 0 ? done() : fail(new Error(`kubectl create: ${err}`))));
        p.stdin.end(JSON.stringify({ apiVersion: "v1", kind: "List", items }));
      });
    }),
  );
}

/** Delete the pods of `selector` without waiting for them to go (async, so
 *  the memory sampler keeps running). */
function deletePods(namespace, selector) {
  return new Promise((done, fail) => {
    const args = ["--context", CONTEXT, "-n", namespace, "delete", "pods", "-l", selector, "--wait=false"];
    const p = spawn("kubectl", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? done() : fail(new Error(`kubectl delete: ${err}`))));
  });
}

function report() {
  const row = (label, r) =>
    r
      ? `| ${label} | ${(r.ms / 1000).toFixed(2)} s | ${r.fps} | ${r.p95Frame} ms | ${r.maxFrame} ms | ${r.longFrames} | ${r.blockedPct}% | ${r.coreCpuS} s | ${r.webCpuS} s | ${r.coreRssMb} / ${r.webRssMb} MB |`
      : `| ${label} | not measured | | | | | | | | |`;
  const md = [
    `### Stream throughput (Linux, WebKitGTK, ${BUILD} build, #115)`,
    "",
    "| Stream | Until shown | fps | Frame p95 | Frame max | Frames > 50 ms | Frame time lost | Core CPU | WebKitWebProcess CPU | Peak RSS core / web |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    row(`Log burst, ${LOG_LINES.toLocaleString("en")} lines (median of ${BURSTS})`, results.logs),
    row("Pod terminal, 10 MB", results.terminal),
    row("Local shell, 10 MB", results.localShell),
    row(`Save the log, ${LOG_LINES.toLocaleString("en")} lines (median of ${REPEATS})`, results.saveLogs),
    row(`YAML of a ${YAML_LINES.toLocaleString("en")}-line ConfigMap (median of ${REPEATS})`, results.yaml),
    row(`Watch snapshot, ${PODS.toLocaleString("en")} pods`, results.watchSnapshot),
    row(`Watch updates, ${CHURN.toLocaleString("en")} of them deleted`, results.watchChurn),
    "",
    ...[
      ["pod terminal", results.terminal],
      ["local shell", results.localShell],
    ]
      .filter(([, r]) => r?.keyMs)
      .map(([label, r]) => `Key presses while the ${label} floods: ${r.keyMs.join(", ")} ms.`),
    results.yesInterrupt
      ? `\`yes\` for ${YES_MS / 1000} s in a local shell, then Ctrl-C: the next command's output after ${results.yesInterrupt.promptMs} ms; ` +
        `peak RSS core / web ${results.yesInterrupt.coreRssMb} / ${results.yesInterrupt.webRssMb} MB; ` +
        `notices: skipped ${results.yesInterrupt.skippedNotice}, at Ctrl-C ${results.yesInterrupt.clearedNotice}.`
      : "",
    "",
    results.kubectlLogsMs ? `\`kubectl logs\` of the same pod (whole log, no follow): ${(results.kubectlLogsMs / 1000).toFixed(2)} s.` : "",
    "",
  ].join("\n");
  writeFileSync(join(ARTIFACTS, "stream-perf.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

describe("stream throughput", { skip, timeout: 25 * 60_000 }, () => {
  let ns;
  let watchNs;
  before(() => {
    ns = tempNamespace("qa-perf", burstPodYaml("burst"));
    waitPodReady(ns, "burst");
  });
  after(() => {
    report();
    deleteNamespace(ns);
    deleteNamespace(watchNs);
  });
  // bash for the local shell, so its prompt is the one `waitForPrompt` knows.
  /** The burst pod's log tab, kept open for the download. */
  let logTab = "";
  const median = (runs) => [...runs].sort((a, b) => a.ms - b.ms)[Math.floor(runs.length / 2)];
  const s = appSession("stream-perf", { env: { SHELL: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh" } });

  it(`shows a burst of ${LOG_LINES} log lines`, T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    const pid = appPid(app.profile.home);
    assert.ok(pid, "found the app's process");
    const id = await openPodLogs(app, ns, "burst");
    logTab = id;
    const lines = `${pane(id)} [data-testid="log-line"]`;
    await app.waitFor(
      () => app.js(`return Array.from(document.querySelectorAll(arguments[0]), (l) => l.textContent).some((t) => t.includes("ready"))`, lines),
      { timeout: 60_000, message: "the ready line" },
    );
    const runs = [];
    for (let i = 1; i <= BURSTS; i++) {
      // Each burst starts from an empty view.
      await (await app.find(By.xpath(`//*[@data-tab=${xq(id)}]//button[normalize-space()='Clear']`))).click();
      const r = await measured(
        app,
        pid,
        { selector: lines, text: `BURST-END-${i}` },
        async () => kubectl(["-n", ns, "exec", "burst", "--", "touch", `/tmp/go${i}`]),
        { timeout: 180_000, message: `the last line of burst ${i}` },
      );
      console.log(`logs, burst ${i}`, JSON.stringify(r));
      runs.push(r);
      if (i === 1) await app.shot("log-burst-shown");
    }
    const r = [...runs].sort((a, b) => a.ms - b.ms)[Math.floor(runs.length / 2)];
    results.logs = r;
    results.logRuns = runs;
    // The same view in the light theme (the others are dark).
    await setTheme(app, "light");
    await app.shot("log-burst-light");
    await setTheme(app, null);
    // What the cluster itself takes to hand over the same log.
    const t0 = Date.now();
    const text = execFileSync("kubectl", ["--context", CONTEXT, "-n", ns, "logs", "burst"], { encoding: "utf8", maxBuffer: 64 << 20 });
    results.kubectlLogsMs = Date.now() - t0;
    assert.ok(text.includes(`BURST-END-${BURSTS}`), "kubectl logs has every burst");
    assert.deepEqual(overBudget(r, LOG_BUDGET), [], `the 50k-line log burst (${BUILD}) is over its budget`);
  });

  // Report-only: what the log download costs (the text goes to the core
  // and into a file in Downloads), from Download to the "Saved to" note.
  it(`saves the ${LOG_LINES} log lines`, T, async () => {
    const { app } = s;
    assert.ok(logTab, "the log tab of the burst test");
    const pid = appPid(app.profile.home);
    const note = `${pane(logTab)} [data-testid="log-saved"]`;
    const noteText = () => app.js(`return document.querySelector(arguments[0])?.textContent ?? ""`, note);
    const runs = [];
    for (let i = 1; i <= REPEATS; i++) {
      // The note of the last save goes after 10 s.
      await app.waitFor(async () => (await noteText()) === "", { timeout: 20_000, message: "no saved note" });
      const r = await measured(
        app,
        pid,
        { selector: note, text: "Saved to" },
        async () => (await app.find(By.xpath(`//*[@data-tab=${xq(logTab)}]//button[normalize-space()='Download']`))).click(),
        { timeout: 60_000, message: `the saved note ${i}` },
      );
      console.log(`save logs ${i}`, JSON.stringify(r));
      runs.push(r);
    }
    results.saveLogs = median(runs);
    const path = await app.profile.waitForDownload(/^burst_.*\.log$/);
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes(`BURST-END-${BURSTS}`), "the saved log has the last burst");
    await app.shot("log-saved");
  });

  // Report-only: one ConfigMap of YAML_LINES lines in its YAML tab, from
  // Reload until the changed first key shows.
  it(`loads the YAML of a ${YAML_LINES}-line ConfigMap`, T, async () => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    const file = join(app.profile.home, "big.txt");
    writeFileSync(file, Array.from({ length: YAML_LINES }, (_, i) => `${String(i).padStart(6, "0")} ${"y".repeat(92)}`).join("\n"));
    kubectl(["-n", ns, "create", "configmap", "big", `--from-file=big.txt=${file}`, "--from-literal=a0=r0"]);
    await app.openDetail("Config Maps", ns, "big");
    const panelEl = await app.find(By.css('[data-testid="detail-panel"]'));
    await (await panelEl.findElement(By.xpath(".//button[@role='tab'][normalize-space()='YAML']"))).click();
    const content = '[data-testid="yaml-editor"] .cm-content';
    await app.waitFor(() => app.js(`return document.querySelector(arguments[0])?.textContent.includes("a0: r0") ?? false`, content), {
      timeout: 60_000,
      message: "the big YAML",
    });
    const runs = [];
    for (let i = 1; i <= REPEATS; i++) {
      kubectl(["-n", ns, "patch", "configmap", "big", "--type=merge", "-p", JSON.stringify({ data: { a0: `r${i}` } })]);
      const r = await measured(
        app,
        pid,
        { selector: content, text: `a0: r${i}` },
        async () => (await panelEl.findElement(By.xpath(".//button[normalize-space()='Reload']"))).click(),
        { timeout: 60_000, message: `the reloaded YAML ${i}` },
      );
      console.log(`yaml ${i}`, JSON.stringify(r));
      runs.push(r);
    }
    results.yaml = median(runs);
    await app.shot("yaml-big");
    await setTheme(app, "light");
    await app.shot("yaml-big-light");
    await setTheme(app, null);
  });

  /** Type `command` in `term` and measure until `marker`42 shows, with key presses timed while it floods. */
  async function flood(app, term, command, marker) {
    const pid = appPid(app.profile.home);
    let keyMs = [];
    const r = await measured(
      app,
      pid,
      { selector: '[data-testid="terminal"] .xterm-rows > *', text: `${marker}42` },
      async () => {
        await term.type(command);
        // A comment character: harmless when the shell reads it later.
        keyMs = await term.keyLatencies("#", 5, 100);
      },
      { timeout: 240_000, message: `the end of the 10 MB output (${marker})` },
    );
    return { ...r, keyMs };
  }

  it("shows 10 MB printed in a pod terminal", T, async () => {
    const { app } = s;
    // A script, so the typed command is short and the marker is not on the screen yet.
    kubectl(["-n", ns, "exec", "burst", "--", "sh", "-c", "printf '%s\\n' \"$1\" > /tmp/b", "_", floodCommand("END")]);
    await app.openDetail("Pods", ns, "burst");
    await panelButton(app, "Shell");
    const term = terminal(app);
    await term.waitForPrompt();
    const r = await flood(app, term, "sh /tmp/b", "END");
    results.terminal = r;
    console.log("pod terminal", JSON.stringify(r));
    await app.shot("terminal-10mb-shown");
    assert.deepEqual(overBudget(r, POD_TERM_BUDGET), [], `10 MB in a pod terminal (${BUILD}) is over its budget`);
  });

  it("shows 10 MB printed in a local shell", T, async () => {
    const { app } = s;
    await app.palette("local term", "New local terminal");
    const term = terminal(app);
    await term.waitForPrompt();
    const script = join(app.profile.home, "flood.sh");
    writeFileSync(script, `${floodCommand("LOCALEND")}\n`);
    const r = await flood(app, term, `sh ${script}`, "LOCALEND");
    results.localShell = r;
    console.log("local shell", JSON.stringify(r));
    await app.shot("local-shell-10mb-shown");
    await setTheme(app, "light");
    await app.shot("local-shell-10mb-light");
    await setTheme(app, null);
    assert.deepEqual(overBudget(r, TERM_BUDGET), [], `10 MB in a local shell (${BUILD}) is over its budget`);
  });

  it("drops what it cannot show under `yes`, with a notice, and Ctrl-C clears the backlog", T, async () => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    const term = terminal(app);
    // Each line draws on the top row and puts the cursor back where it was
    // (save, home, digits, restore, up; the PTY's newline comes back down),
    // so the flood never scrolls: the notices, written at the cursor, stay
    // on the screen.
    const script = join(app.profile.home, "yes.sh");
    writeFileSync(script, "yes \"$(printf '\\0337\\033[H%080d\\0338\\033[A' 0)\"\n");
    const mem = peakMemory(pid);
    const skipped = /\[… [\d.]+ [KM]B of output skipped\]/;
    const atCtrlC = /\[… [\d.]+ [KM]B of output skipped at Ctrl-C\]/;
    let r = {};
    try {
      // The keys pressed during the last flood are still on the line.
      await term.interrupt();
      await term.waitFor(/\$\s*$/, { message: "an empty prompt" });
      const t0 = performance.now();
      await term.type(`bash ${script}`);
      await term.waitFor(skipped, { timeout: 60_000, message: "a notice of skipped output" });
      r.skippedAfterMs = Math.round(performance.now() - t0);
      await new Promise((done) => setTimeout(done, YES_MS));
      await app.shot("yes-skipped-notice");
      const t1 = performance.now();
      // The Ctrl-C notice is written at the cursor, and the prompt that
      // follows can land on the same row and cover it (#477): watch the
      // screen from Ctrl-C on instead of reading it once at the end.
      let sawAtCtrlC = false;
      let watching = true;
      const watcher = (async () => {
        while (watching && !sawAtCtrlC) {
          sawAtCtrlC = atCtrlC.test(await term.screen());
          await new Promise((done) => setTimeout(done, 50));
        }
      })();
      await term.interrupt();
      // Typed ahead: the shell runs it once `yes` has stopped.
      await term.type("echo YES$((40+2))DONE");
      await term.waitFor("YES42DONE", { timeout: 60_000, message: "the command typed after Ctrl-C" });
      r.promptMs = Math.round(performance.now() - t1);
      watching = false;
      await watcher;
      r.clearedNotice = sawAtCtrlC;
    } finally {
      r = { ...r, ...mem.stop() };
    }
    const screen = await term.screen();
    r.skippedNotice = skipped.test(screen);
    r.clearedNotice = Boolean(r.clearedNotice) || atCtrlC.test(screen);
    results.yesInterrupt = r;
    console.log("yes then Ctrl-C", JSON.stringify(r));
    await app.shot("yes-interrupted");
    assert.ok(r.skippedNotice, "the flood's output was dropped, with a notice");
    assert.ok(r.clearedNotice, "Ctrl-C dropped the backlog, with a notice");
    assert.deepEqual(overBudget(r, YES_BUDGET), [], `\`yes\` then Ctrl-C (${BUILD}) is over its budget`);
  });

  it(`watches ${PODS} pods`, { timeout: 900_000 }, async () => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    watchNs = tempNamespace("qa-perf-watch");
    const t0 = Date.now();
    await createPods(watchNs, PODS);
    console.log(`created ${PODS} pods in ${Date.now() - t0} ms`);
    await app.nav("Deployments");
    await app.filter("");
    await pickNamespaces(app, [watchNs]);
    const rows = (n) => ({ selector: '[data-testid="resource-table"] [role="grid"]', attr: "aria-rowcount", value: String(n + 1) });
    results.watchSnapshot = await measured(app, pid, rows(PODS), () => app.nav("Pods"), {
      timeout: 180_000,
      message: `${PODS} pod rows`,
    });
    console.log("watch snapshot", JSON.stringify(results.watchSnapshot));
    await app.shot("watch-5k-pods");
    // Incremental batches: CHURN deletions, at the API server's pace (the
    // table gets them coalesced, #115). Report-only: paced by the API server.
    results.watchChurn = await measured(app, pid, rows(PODS - CHURN), () => deletePods(watchNs, "churn=yes"), {
      timeout: 300_000,
      message: `${PODS - CHURN} pod rows after deleting ${CHURN}`,
    });
    console.log("watch churn", JSON.stringify(results.watchChurn));
    await app.shot("watch-after-churn");
    // Not timed: deleting 5k pods goes at the API server's pace (minutes on
    // kind), not the app's. The namespace goes in `after`.
    assert.deepEqual(overBudget(results.watchSnapshot, WATCH_BUDGET), [], `the ${PODS}-pod watch snapshot (${BUILD}) is over its budget`);
  });
});
