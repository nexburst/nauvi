// Idle memory on Linux (#341): the app goes Live on the Overview, sits there
// for 30 s untouched, then the resident memory of the core (nauvi-desktop)
// and of the WebKitGTK processes it started is read from /proc.
//
// Report only: it fails if it cannot measure, never on a big number. The
// numbers go to the console, to artifacts/idle-memory.json and, on GitHub
// Actions, to the job summary.
//
// A debug build uses more memory than the release one, so qa.yml builds a
// release binary for this scenario and passes it in QA_RELEASE_APP; without
// it (a local `qa.sh idle-memory`) the debug build is measured and the
// report says so. Set IDLE_SECONDS to idle for longer or shorter.
//
// RSS counts the shared libraries in every process that maps them, so the
// sum over-counts what the processes take together; PSS splits shared pages
// between the processes and is the fairer total. Both are reported.

import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS } from "../lib/app.mjs";
import { appPid } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const IDLE_MS = Number(process.env.IDLE_SECONDS || 30) * 1000;
const RELEASE = process.env.QA_RELEASE_APP && existsSync(process.env.QA_RELEASE_APP);
// Read by lib/app.mjs when the app starts; node --test runs each file in its
// own process, so this only affects this scenario.
if (RELEASE) process.env.NAUVI_APP = resolve(process.env.QA_RELEASE_APP);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = process.platform !== "linux" ? "reads /proc (Linux only)" : false;

/** kB from a "Name:   1234 kB" line of a /proc file, or 0. */
function kb(path, field) {
  try {
    const m = readFileSync(path, "utf8").match(new RegExp(`^${field}:\\s+(\\d+) kB`, "m"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** pid -> parent pid for every process. */
function parents() {
  const map = new Map();
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      // The comm field may hold spaces and parentheses: split after the last ")".
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      map.set(Number(pid), ppid);
    } catch {
      /* gone */
    }
  }
  return map;
}

/** `root` and all its descendants. */
function tree(root) {
  const ppid = parents();
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const [pid, parent] of ppid) if (parent === out[i]) out.push(pid);
  }
  return out;
}

/** RSS and PSS (kB) of the app's processes, grouped by kind. */
function measure(root) {
  const groups = { core: [], web: [], network: [], other: [] };
  for (const pid of tree(root)) {
    let comm;
    try {
      comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      continue;
    }
    const p = { pid, comm, rss: kb(`/proc/${pid}/status`, "VmRSS"), pss: kb(`/proc/${pid}/smaps_rollup`, "Pss") };
    // comm is cut at 15 characters: WebKitWebProces, WebKitNetworkPr.
    if (pid === root) groups.core.push(p);
    else if (comm.startsWith("WebKitWebProc")) groups.web.push(p);
    else if (comm.startsWith("WebKitNetwork")) groups.network.push(p);
    else groups.other.push(p);
  }
  const sum = (list, key) => list.reduce((n, p) => n + p[key], 0);
  const row = (list) => ({ rss: sum(list, "rss"), pss: sum(list, "pss"), count: list.length });
  const all = Object.values(groups).flat();
  return {
    core: row(groups.core),
    web: row(groups.web),
    network: row(groups.network),
    other: row(groups.other),
    coreAndWeb: row([...groups.core, ...groups.web]),
    total: row(all),
    processes: all,
  };
}

const mb = (k) => (k / 1024).toFixed(0);

/**
 * The biggest mappings of `pid` by RSS, grouped by backing file (anonymous
 * memory by permissions): where the memory is, for #353. kB.
 */
function topMappings(pid, n = 12) {
  let text;
  try {
    text = readFileSync(`/proc/${pid}/smaps`, "utf8");
  } catch {
    return [];
  }
  const groups = new Map();
  let cur = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^[0-9a-f]+-[0-9a-f]+ (\S+) \S+ \S+ \S+\s*(.*)$/);
    if (head) {
      const file = head[2].trim();
      const name = file ? file.split("/").pop() : `[anon ${head[1]}]`;
      cur = groups.get(name) ?? { name, rss: 0, pss: 0, maps: 0 };
      cur.maps++;
      groups.set(name, cur);
      continue;
    }
    const field = line.match(/^(Rss|Pss):\s+(\d+) kB/);
    if (field && cur) cur[field[1].toLowerCase()] += Number(field[2]);
  }
  return [...groups.values()].sort((a, b) => b.rss - a.rss).slice(0, n);
}

/** Counters from the page: what the UI holds (WebKit has no performance.memory). */
async function pageCounters(app) {
  try {
    return await app.js(() => ({
      domNodes: document.getElementsByTagName("*").length,
      scripts: performance.getEntriesByType("resource").filter((e) => e.initiatorType === "script").length,
      styleRules: [...document.styleSheets].reduce((n, sh) => {
        try {
          return n + sh.cssRules.length;
        } catch {
          return n;
        }
      }, 0),
    }));
  } catch (e) {
    return { error: String(e) };
  }
}

function markdown(r) {
  const line = (label, x) => `| ${label} | ${x.count} | ${mb(x.rss)} MB | ${mb(x.pss)} MB |`;
  return [
    `### Idle memory (Linux, WebKitGTK, ${r.build} build)`,
    "",
    `After ${r.idleSeconds} s idle on the Overview, connected to kind.`,
    "",
    "| Processes | Count | RSS | PSS |",
    "| --- | ---: | ---: | ---: |",
    line("Core (nauvi-desktop)", r.core),
    line("WebKitWebProcess", r.web),
    line("**Core + WebKitWebProcess**", r.coreAndWeb),
    line("WebKitNetworkProcess", r.network),
    line("Other (helpers)", r.other),
    line("All", r.total),
    "",
    "RSS counts shared libraries once per process; PSS shares them out.",
    "",
  ].join("\n");
}

describe("idle memory on the Overview", { skip, timeout: 5 * 60_000 }, () => {
  const s = appSession("idle-memory");

  it("measures the core and WebKitWebProcess after 30 s idle", { timeout: 180_000 }, async () => {
    const { app } = s;
    await waitLive(app);
    await app.find(By.css(".overview .card"), { timeout: 60_000 });
    await sleep(IDLE_MS);

    const pid = appPid(app.profile.home);
    assert.ok(pid, "found the app's process");
    // Three samples a second apart; the median of the core + web RSS.
    const samples = [];
    for (let i = 0; i < 3; i++) {
      samples.push(measure(pid));
      if (i < 2) await sleep(1000);
    }
    samples.sort((a, b) => a.coreAndWeb.rss - b.coreAndWeb.rss);
    const r = { ...samples[1], build: RELEASE ? "release" : "debug", idleSeconds: IDLE_MS / 1000 };
    console.log(JSON.stringify(r, null, 2));
    assert.ok(r.core.rss > 0, "read the core's RSS");
    assert.ok(r.web.count > 0, `a WebKitWebProcess under the app: ${JSON.stringify(r.processes)}`);

    r.page = await pageCounters(app);
    r.mappings = Object.fromEntries(
      [pid, ...r.processes.filter((p) => p.comm.startsWith("WebKitWebProc")).map((p) => p.pid)].map((p) => [
        p,
        topMappings(p),
      ]),
    );
    writeFileSync(join(ARTIFACTS, "idle-memory.json"), JSON.stringify(r, null, 2));
    const md = markdown(r);
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  });
});
