// Stream throughput in the real app (#115): how long the UI takes to show
//   - a burst of 50k log lines in a pod's log tab,
//   - 10 MB printed in a pod terminal,
//   - a watch of 5k pods (the first snapshot, then all 5k deleted at once),
// with the frame times of the page, the CPU time of the core and of the
// WebKitWebProcess, and their peak memory.
//
// The numbers go to the console, artifacts/stream-perf.json and, on GitHub
// Actions, the job summary. The log burst has a budget (LOG_BUDGET); the
// other two are report-only. QA_PERF_BUDGET=off turns the budget off.
//
// qa.yml builds a release binary when idle-memory runs; with
// QA_RELEASE_APP set this scenario measures it too (run it as
// `-f scenario='stream-perf idle-memory'`), else the debug build.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { ARTIFACTS, CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appPid, openPodLogs, pane, panelButton } from "../lib/dock.mjs";
import { measured } from "../lib/perf.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { terminal } from "../lib/terminal.mjs";
import { resizeWindow } from "../lib/window.mjs";

const RELEASE = process.env.QA_RELEASE_APP && existsSync(process.env.QA_RELEASE_APP);
if (RELEASE) process.env.NAUVI_APP = resolve(process.env.QA_RELEASE_APP);
const BUILD = RELEASE ? "release" : "debug";

const LOG_LINES = 50_000;
const TERM_BYTES = 10 * 1024 * 1024;
const PODS = Number(process.env.QA_PERF_PODS || 5000);

/**
 * The 50k-line burst, on the CI runner (either build). Measured after #115
 * moved logs to a channel; the limits leave about 3x room for a slow runner.
 */
const LOG_BUDGET = { ms: 15_000, coreCpuS: 6, webCpuS: 20, coreAndWebRssMb: 900 };

const skip = process.platform !== "linux" ? "reads /proc (Linux only)" : false;
const T = { timeout: 300_000 };
const results = { build: BUILD };

/** A pod that logs "ready", waits for /tmp/go, then prints LOG_LINES lines at once. */
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
      command: ["sh", "-c", "echo ready; while [ ! -f /tmp/go ]; do sleep 0.1; done; seq 1 ${LOG_LINES} | sed 's/.*/${line}/'; echo BURST-END; exec sleep 3600"]
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
    row(`Log burst, ${LOG_LINES.toLocaleString("en")} lines`, results.logs),
    row("Terminal, 10 MB", results.terminal),
    row(`Watch snapshot, ${PODS.toLocaleString("en")} pods`, results.watchSnapshot),
    row(`Watch, ${PODS.toLocaleString("en")} pods deleted`, results.watchDelete),
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
    const r = await measured(
      app,
      pid,
      { selector: lines, text: "BURST-END" },
      async () => kubectl(["-n", ns, "exec", "burst", "--", "touch", "/tmp/go"]),
      { timeout: 180_000, message: "the last line of the burst" },
    );
    results.logs = r;
    console.log("logs", JSON.stringify(r));
    await app.shot("log-burst-shown");
    // What the cluster itself takes to hand over the same log.
    const t0 = Date.now();
    const text = execFileSync("kubectl", ["--context", CONTEXT, "-n", ns, "logs", "burst"], { encoding: "utf8", maxBuffer: 64 << 20 });
    results.kubectlLogsMs = Date.now() - t0;
    assert.ok(text.includes("BURST-END"), "kubectl logs has the whole burst");
    if (process.env.QA_PERF_BUDGET !== "off") {
      const over = Object.entries(LOG_BUDGET)
        .filter(([k, limit]) => r[k] > limit)
        .map(([k, limit]) => `${k} ${r[k]} > ${limit}`);
      assert.deepEqual(over, [], "the 50k-line log burst is over its budget");
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
    const rows = (n) => ({ selector: '[data-testid="resource-table"]', attr: "aria-rowcount", value: String(n + 1) });
    results.watchSnapshot = await measured(app, pid, rows(PODS), () => app.nav("Pods"), {
      timeout: 180_000,
      message: `${PODS} pod rows`,
    });
    console.log("watch snapshot", JSON.stringify(results.watchSnapshot));
    await app.shot("watch-5k-pods");
    results.watchDelete = await measured(
      app,
      pid,
      rows(0),
      // One deletecollection: the API server sends the 5k deletions in a burst.
      async () => kubectl(["delete", "--raw", `/api/v1/namespaces/${watchNs}/pods`]),
      { timeout: 600_000, message: "every pod row gone" },
    );
    console.log("watch delete", JSON.stringify(results.watchDelete));
  });
});
