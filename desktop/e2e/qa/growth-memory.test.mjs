// Memory growth under use (#397), next to idle-memory: how much the app's
// memory grows with a table of 5,000 ConfigMaps and with a 50,000-line log
// tab, and whether leaving them gives it back.
//
// Steps, in one app: idle on the Overview (the baseline); the Config Maps
// table with every row loaded; back on the Overview; the same table again;
// back on the Overview; a pod's log tab with all of its 50,000 lines; the
// tab closed. At each step the private dirty memory (what the process
// itself wrote: heap, JS heap, buffers; not shared library pages, which
// RSS also counts) of the core and of the WebKitWebProcess is the median of
// SAMPLES reads a second apart, after the step has settled.
//
// The budgets are on the growth over the baseline, so the machine's idle
// level does not matter. Before #397 a table watch kept every full object
// in a reflector store nothing read: 5,023 ConfigMaps added 84 MB to the
// core, kept after leaving, and 31 MB more on each visit. The numbers go to
// the console, artifacts/growth-memory.json and, on GitHub Actions, the job
// summary. QA_MEMORY_BUDGET=off turns the budgets off; GROWTH_OBJECTS
// changes the number of ConfigMaps.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appPid, closeTab, logStatus, openPodLogs } from "../lib/dock.mjs";
import { measure } from "../lib/memory.mjs";
import { closePanel } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";

const RELEASE = process.env.QA_RELEASE_APP && existsSync(process.env.QA_RELEASE_APP);
if (RELEASE) process.env.NAUVI_APP = resolve(process.env.QA_RELEASE_APP);
const BUILD = RELEASE ? "release" : "debug";

const OBJECTS = Number(process.env.GROWTH_OBJECTS || 5000);
const LOG_LINES = 50_000;
const SAMPLES = 5;
/** How long a step settles before it is measured. */
const SETTLE_MS = 15_000;

/**
 * Growth over the baseline, MB of private dirty memory. Measured on this
 * scenario (#397): see the PR for the numbers; the limits leave room for
 * the allocator's and the JS garbage collector's timing.
 */
const BUDGET = {
  // The table open: the rows in the core (and the batcher's copy of them).
  coreTable: 40,
  // After leaving it: the rows are gone.
  coreLeft: 15,
  // The second visit costs what the first did, not more.
  coreSecondVisit: 40,
  // The page's rows (and their search text) while the table shows.
  webTable: 60,
  // The rest are measured from the Overview after the tables, with the
  // pod's table and detail panel open next to the log tab.
  // A 50,000-line log tab: the lines in the page.
  webLog: 80,
  // The log stream in the core: bounded by its flow control.
  coreLog: 25,
  // The tab closed, back on the Overview: the core gives it back. The
  // page's JS heap is collected when WebKit decides; it must not grow
  // after the tab closed, at least.
  coreLogClosed: 10,
  webLogClosedOverOpen: 5,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = process.platform !== "linux" ? "reads /proc (Linux only)" : false;
const T = { timeout: 600_000 };

/** MB from a /proc/<pid>/smaps_rollup field. */
function rollup(pid, field) {
  try {
    const t = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    return Number(t.match(new RegExp(`^${field}:\\s+(\\d+) kB`, "m"))?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
}

/** One read: private dirty and RSS of the core and of the web processes, MB. */
function read(root) {
  const m = measure(root);
  const web = m.processes.filter((p) => p.comm.startsWith("WebKitWebProc"));
  const sum = (list, f) => list.reduce((n, p) => n + f(p.pid), 0);
  return {
    core: rollup(root, "Private_Dirty"),
    web: sum(web, (pid) => rollup(pid, "Private_Dirty")),
    coreRss: m.core.rss / 1024,
    webRss: m.web.rss / 1024,
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 10) / 10;

const steps = [];

/** The median of SAMPLES reads, a second apart, saved as step `label`. */
async function sample(app, label) {
  const pid = appPid(app.profile.home);
  assert.ok(pid, "found the app's process");
  const reads = [];
  for (let i = 0; i < SAMPLES; i++) {
    reads.push(read(pid));
    if (i < SAMPLES - 1) await sleep(1000);
  }
  const step = { label };
  for (const k of Object.keys(reads[0])) step[k] = round(median(reads.map((r) => r[k])));
  steps.push(step);
  console.log(`growth ${label}: ${JSON.stringify(step)}`);
  return step;
}

/** Growth of step `label` over step `from` (the baseline), MB. */
function growth(label, key, from = "baseline") {
  const base = steps.find((s) => s.label === from);
  const s = steps.find((x) => x.label === label);
  return s && base ? round(s[key] - base[key]) : NaN;
}

/** The table's "<shown> of <total> items", as numbers (null: none yet). */
async function tableCount(app) {
  const text = await app.js("return document.body.innerText");
  const m = text.match(/([\d,]+) of ([\d,]+) items/);
  return m ? { shown: Number(m[1].replace(/,/g, "")), total: Number(m[2].replace(/,/g, "")) } : null;
}

async function openTable(app) {
  await app.nav("Config Maps");
  await app.waitFor(async () => ((await tableCount(app))?.total ?? 0) >= OBJECTS, {
    timeout: 180_000,
    message: `${OBJECTS} ConfigMaps in the table`,
  });
}

async function overview(app) {
  await app.nav("Overview");
  await app.find(By.css(".overview .card"), { timeout: 60_000 });
}

function report() {
  const base = steps.find((s) => s.label === "baseline");
  const line = (s) =>
    `| ${s.label} | ${s.core} (${base ? `${s.core - base.core >= 0 ? "+" : ""}${round(s.core - base.core)}` : ""}) | ${s.web} (${base ? `${s.web - base.web >= 0 ? "+" : ""}${round(s.web - base.web)}` : ""}) | ${s.coreRss} | ${s.webRss} |`;
  const md = [
    `### Memory growth (Linux, WebKitGTK, ${BUILD} build, #397)`,
    "",
    `${OBJECTS.toLocaleString("en")} ConfigMaps, then a ${LOG_LINES.toLocaleString("en")}-line log tab. Median of ${SAMPLES} reads per step, MB.`,
    "",
    "| Step | Core private dirty (growth) | WebKitWebProcess private dirty (growth) | Core RSS | Web RSS |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...steps.map(line),
    "",
  ].join("\n");
  writeFileSync(join(ARTIFACTS, "growth-memory.json"), JSON.stringify({ build: BUILD, objects: OBJECTS, steps }, null, 2));
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

/** The keys over their budget, as "what +x MB > limit MB" (none: budgets off). */
function over(checks) {
  if (process.env.QA_MEMORY_BUDGET === "off") return [];
  return checks.filter(([, mb, limit]) => !(mb <= limit)).map(([what, mb, limit]) => `${what} +${mb} MB > ${limit} MB`);
}

/** A pod that prints LOG_LINES lines of about 125 characters, then waits. */
function loggerYaml(name) {
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
      command:
        - sh
        - -c
        - i=0; while [ $i -lt ${LOG_LINES} ]; do echo "$i 2026-11-17T00:00:00Z INFO some.module request handled path=/api/v1/items/$i status=200 duration_ms=12 user=someone"; i=$((i+1)); done; echo LOG-END; sleep 36000
`;
}

describe("memory growth with a big table and a big log", { skip, timeout: 30 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-growth", loggerYaml("biglog"));
    const items = [];
    for (let i = 0; i < OBJECTS; i++) {
      const data = {};
      for (let k = 0; k < 20; k++) data[`key-${k}`] = `value-${i}-${k}-`.padEnd(100, "x");
      items.push({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: `cm-${String(i).padStart(5, "0")}`,
          labels: { app: "qa-growth", tier: `t${i % 7}` },
          annotations: { "example.com/note": "n".repeat(200) },
        },
        data,
      });
    }
    execFileSync("kubectl", ["--context", CONTEXT, "-n", ns, "create", "-f", "-", "-o", "name"], {
      input: JSON.stringify({ apiVersion: "v1", kind: "List", items }),
      stdio: ["pipe", "ignore", "inherit"],
      maxBuffer: 1 << 28,
    });
    waitPodReady(ns, "biglog");
  });
  after(() => {
    report();
    deleteNamespace(ns);
  });
  const s = appSession("growth-memory");

  it("baseline: idle on the Overview", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.find(By.css(".overview .card"), { timeout: 60_000 });
    await sleep(20_000);
    await sample(app, "baseline");
  });

  it(`a table of ${OBJECTS} ConfigMaps grows little and gives it back when left`, T, async () => {
    const { app } = s;
    await openTable(app);
    await sleep(SETTLE_MS);
    await sample(app, "table");
    await app.shot("configmaps-table");
    await setTheme(app, "light");
    await app.shot("configmaps-table-light");
    await setTheme(app, null);

    await overview(app);
    await sleep(SETTLE_MS);
    await sample(app, "table left");

    await openTable(app);
    await sleep(SETTLE_MS);
    await sample(app, "table again");
    await overview(app);
    await sleep(SETTLE_MS);
    await sample(app, "table left again");
    await app.shot("overview-after-tables");

    assert.deepEqual(
      over([
        ["core, table open", growth("table", "core"), BUDGET.coreTable],
        ["core, table left", growth("table left", "core"), BUDGET.coreLeft],
        ["core, second visit", growth("table again", "core"), BUDGET.coreSecondVisit],
        ["core, left again", growth("table left again", "core"), BUDGET.coreLeft],
        ["web, table open", growth("table", "web"), BUDGET.webTable],
      ]),
      [],
      `growth of the table (${BUILD}) over its budget`,
    );
  });

  it(`a ${LOG_LINES}-line log tab grows the page, not the core, and closing it gives it back`, T, async () => {
    const { app } = s;
    const id = await openPodLogs(app, ns, "biglog");
    await app.js(
      `const el = document.querySelector(arguments[0] + ' select[title="Tail lines"]');
       el.value = "all"; el.dispatchEvent(new Event("change", { bubbles: true }));`,
      `[data-testid="dock-pane"][data-tab=${JSON.stringify(id)}]`,
    );
    await app.waitFor(async () => /50[,.\s]?000\+ lines/.test(await logStatus(app, id)), {
      timeout: 180_000,
      message: `${LOG_LINES} lines in the log tab`,
    });
    await sleep(SETTLE_MS);
    console.log(`log status: ${await logStatus(app, id)}`);
    await sample(app, "log tab");
    await app.shot("log-50k");

    await closeTab(app, "Logs: biglog");
    await closePanel(app);
    await overview(app);
    await sleep(2 * SETTLE_MS);
    await sample(app, "log tab closed");
    await app.shot("log-closed");

    const before = "table left again";
    assert.deepEqual(
      over([
        ["core, log tab", growth("log tab", "core", before), BUDGET.coreLog],
        ["web, log tab", growth("log tab", "web", before), BUDGET.webLog],
        ["core, log tab closed", growth("log tab closed", "core", before), BUDGET.coreLogClosed],
        ["web, log tab closed", growth("log tab closed", "web", "log tab"), BUDGET.webLogClosedOverOpen],
      ]),
      [],
      `growth of the log tab (${BUILD}) over its budget`,
    );
  });
});
