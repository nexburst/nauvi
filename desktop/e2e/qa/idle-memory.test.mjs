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
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS } from "../lib/app.mjs";
import { appPid } from "../lib/dock.mjs";
import { measure, topMappings } from "../lib/memory.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const IDLE_MS = Number(process.env.IDLE_SECONDS || 30) * 1000;
const RELEASE = process.env.QA_RELEASE_APP && existsSync(process.env.QA_RELEASE_APP);
// Read by lib/app.mjs when the app starts; node --test runs each file in its
// own process, so this only affects this scenario.
if (RELEASE) process.env.NAUVI_APP = resolve(process.env.QA_RELEASE_APP);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = process.platform !== "linux" ? "reads /proc (Linux only)" : false;

const mb = (k) => (k / 1024).toFixed(0);

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
