// Stream throughput in the real app (#115): how long the UI takes to show
//   - a burst of 50k log lines in a pod's log tab,
//   - 10 MB printed in a pod terminal,
//   - the first snapshot of a watch of 5k pods,
// with the frame times of the page, the CPU time of the core and of the
// WebKitWebProcess, and their peak memory.
//
// The numbers go to the console, artifacts/stream-perf.json and, on GitHub
// Actions, the job summary. The log burst has a budget (LOG_BUDGET, per
// build); the other two are report-only. QA_PERF_BUDGET=off turns it off.
//
// qa.yml builds a release binary when idle-memory runs; with
// QA_RELEASE_APP set this scenario measures it too (run it as
// `-f scenario='stream-perf idle-memory'`), else the debug build.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, CONTEXT, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appPid, openPodLogs, pane, panelButton } from "../lib/dock.mjs";
import { measured } from "../lib/perf.mjs";
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

/** Log bursts measured; the median one is reported and checked. */
const BURSTS = 3;

/**
 * The 50k-line burst (median of BURSTS). Release: the qa.yml runner showed
 * 0.7-0.9 s, frame p95 30-45 ms, core 0.2-0.3 s and web 0.6 s CPU, 420 MB
 * RSS (#115); the limits leave 4x or more for a slow runner. Debug: a
 * loaded 4-core dev box showed 3-5 s, p95 100-125 ms, 4 s CPU each, 600 MB.
 */
const LOG_BUDGET = RELEASE
  ? { ms: 4000, p95Frame: 150, coreCpuS: 1.5, webCpuS: 3, coreAndWebRssMb: 800 }
  : { ms: 20_000, p95Frame: 400, coreCpuS: 12, webCpuS: 15, coreAndWebRssMb: 1200 };

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
    metadata: { name: `w-${String(i).padStart(5, "0")}`, labels: { app: "qa-watch" } },
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
    row("Terminal, 10 MB", results.terminal),
    row(`Watch snapshot, ${PODS.toLocaleString("en")} pods`, results.watchSnapshot),
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
  const s = appSession("stream-perf");

  it(`shows a burst of ${LOG_LINES} log lines`, T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    const pid = appPid(app.profile.home);
    assert.ok(pid, "found the app's process");
    const id = await openPodLogs(app, ns, "burst");
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
    if (process.env.QA_PERF_BUDGET !== "off") {
      const over = Object.entries(LOG_BUDGET)
        .filter(([k, limit]) => r[k] > limit)
        .map(([k, limit]) => `${k} ${r[k]} > ${limit}`);
      assert.deepEqual(over, [], `the 50k-line log burst (${BUILD}) is over its budget`);
    }
  });

  it("shows 10 MB printed in a terminal", T, async () => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    // A script, so the typed command is short and the marker is not on the screen yet.
    kubectl(
      ["-n", ns, "exec", "burst", "--", "sh", "-c", "printf '%s\\n' \"$1\" > /tmp/b", "_",
       `head -c ${TERM_BYTES} /dev/zero | tr '\\0' x | fold -w 100; echo END$((40+2))`],
    );
    await app.openDetail("Pods", ns, "burst");
    await panelButton(app, "Shell");
    const term = terminal(app);
    await term.waitForPrompt();
    const r = await measured(
      app,
      pid,
      { selector: '[data-testid="terminal"] .xterm-rows > *', text: "END42" },
      () => term.type("sh /tmp/b"),
      { timeout: 240_000, message: "the end of the 10 MB output" },
    );
    results.terminal = r;
    console.log("terminal", JSON.stringify(r));
    await app.shot("terminal-10mb-shown");
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
    // Not timed: deleting 5k pods goes at the API server's pace (minutes on
    // kind), not the app's. The namespace goes in `after`.
  });
});
