// The multi-cluster budgets of the whole app (ADR 0007, #333 PR 6), Linux.
//
// Memory: 6 contexts that all point at kind (scripts/test-cluster/multi-
// kubeconfig.sh). The app shows the first; after an idle while the PSS of
// the core plus its WebKitWebProcess is read. Then the other 5 are expanded
// in the tree (each connects in the background and lists its kinds) and,
// after another idle while, read again: (PSS6 - PSS1) / 5 must stay within
// MB_PER_CLUSTER. Each reading is the median of 3 samples.
//
// Start-up: 50 contexts in 3 kubeconfig files, 49 of them unreachable
// (a TEST-NET address), against 1 context. The tree must show within
// TREE_MS of the app's start, and at most SLOWER_MS later than with 1
// context. That time is taken in two parts, because under WebKitWebDriver
// the page only starts loading once the driver has attached (about 30 s
// on the CI runner), which says nothing about the app:
//   1. until the page starts loading: the app binary run directly (as a
//      click on its icon would, on a private session bus), until it logs
//      "page load started"; LOAD_STARTS starts, alternating 1 and 50;
//   2. from there until the tree shows: the `nauvi:cluster-tree` mark
//      ClusterTree sets when it first lists contexts, read through the
//      driver (this part does not depend on it); median of STARTS starts.
// On X11 some starts load the page about 500 ms late whatever the
// kubeconfig (#369). The total (TREE_MS) takes the median of part 1, so it
// includes that stall; the slowdown (SLOWER_MS) takes the fastest start of
// each, so it measures what the contexts cost and not the stall.
//
// A release build (QA_RELEASE_APP, which qa.yml builds for this scenario)
// is measured when there is one; otherwise the debug build, and the report
// says so. The numbers go to the console, artifacts/multicluster.json and,
// on GitHub Actions, the job summary. QA_MEMORY_BUDGET=off reports without
// failing.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { ARTIFACTS, CONTEXT, launch } from "../lib/app.mjs";
import { appPid } from "../lib/dock.mjs";
import { measure } from "../lib/memory.mjs";
import { setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { appBinary, startBus } from "../lib/second-launch.mjs";
import { expandCluster, nodeState, nodeText, waitNodeState } from "../lib/tree.mjs";
import { resizeWindow } from "../lib/window.mjs";

/** Budgets (ADR 0007). */
const MB_PER_CLUSTER = 15;
const TREE_MS = 1500;
const SLOWER_MS = 200;
const STARTS = 3;
const LOAD_STARTS = 5;

const CLUSTERS = 6;
const IDLE_MS = Number(process.env.IDLE_SECONDS || 20) * 1000;
const RELEASE = process.env.QA_RELEASE_APP && existsSync(process.env.QA_RELEASE_APP);
// Read by lib/app.mjs when the app starts (this file runs in its own process).
if (RELEASE) process.env.NAUVI_APP = resolve(process.env.QA_RELEASE_APP);
const ENFORCE = process.env.QA_MEMORY_BUDGET !== "off";

const skip = process.platform !== "linux" ? "reads /proc (Linux only)" : false;
const T = { timeout: 300_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (kb) => kb / 1024;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/test-cluster/multi-kubeconfig.sh");
const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-budget-"));
/** A kubeconfig file from multi-kubeconfig.sh. */
function kubeconfig(name, reachable, unreachable = 0, prefix = "budget") {
  const path = join(dir, name);
  execFileSync("bash", [SCRIPT, path, String(reachable), String(unreachable), prefix], {
    env: { ...process.env, NAUVI_TEST_CONTEXT: CONTEXT },
  });
  return path;
}

const report = { build: RELEASE ? "release" : "debug" };
function summary(md) {
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

/** Core + WebKitWebProcess PSS, kB: the median of 3 samples a second apart. */
async function pss(app) {
  const pid = appPid(app.profile.home);
  assert.ok(pid, "found the app's process");
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const m = measure(pid);
    assert.ok(m.web.count > 0, "a WebKitWebProcess under the app");
    samples.push(m.coreAndWeb.pss);
    if (i < 2) await sleep(1000);
  }
  return median(samples);
}

async function shots(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

describe("multi-cluster budgets", { skip, timeout: 30 * 60_000 }, () => {
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(join(ARTIFACTS, "multicluster.json"), JSON.stringify(report, null, 2));
  });

  describe("memory per idle connected cluster", () => {
    const s = appSession("multicluster", { kubeconfig: kubeconfig("six", CLUSTERS) });

    it(`(PSS${CLUSTERS} - PSS1) / ${CLUSTERS - 1} of core + WebKitWebProcess is at most ${MB_PER_CLUSTER} MB`, T, async () => {
      const { app } = s;
      await resizeWindow(app, 1280, 800);
      await waitLive(app);
      assert.equal(await nodeState(app, "budget-1"), "visible");
      for (let i = 2; i <= CLUSTERS; i++) assert.equal(await nodeState(app, `budget-${i}`), "idle");
      await sleep(IDLE_MS);
      const one = await pss(app);

      for (let i = 2; i <= CLUSTERS; i++) {
        const id = `budget-${i}`;
        await expandCluster(app, id);
        await waitNodeState(app, id, "connected");
        await app.waitFor(async () => (await nodeText(app, id)).includes("Workloads"), { message: `${id}'s resource groups` });
      }
      assert.equal(await app.statusText(), "Live");
      await sleep(IDLE_MS);
      const six = await pss(app);
      await shots(app, `${CLUSTERS}-connected`);

      const per = (six - one) / (CLUSTERS - 1);
      report.memory = { pss1Kb: one, pss6Kb: six, perClusterKb: per, idleSeconds: IDLE_MS / 1000 };
      summary(
        [
          `### Whole-app memory per idle cluster (ADR 0007, ${report.build} build)`,
          "",
          `Core + WebKitWebProcess PSS after ${IDLE_MS / 1000} s idle, median of 3 samples.`,
          "",
          "| Connected clusters | PSS |",
          "| ---: | ---: |",
          `| 1 | ${mb(one).toFixed(1)} MB |`,
          `| ${CLUSTERS} | ${mb(six).toFixed(1)} MB |`,
          "",
          `Per extra cluster: **${mb(per).toFixed(1)} MB** (budget ${MB_PER_CLUSTER} MB).`,
          "",
        ].join("\n"),
      );
      if (ENFORCE) assert.ok(mb(per) <= MB_PER_CLUSTER, `${mb(per).toFixed(1)} MB per idle cluster > ${MB_PER_CLUSTER} MB`);
    });
  });

  describe("start-up with 50 contexts", () => {
    /** ms from spawning the app binary until it logs that its page started loading. */
    async function untilPageLoads(kc) {
      const bus = await startBus();
      const profile = createProfile();
      const env = {
        ...process.env,
        ...profile.env(),
        KUBECONFIG: kc,
        NAUVI_NO_SHELL_ENV: "1",
        DBUS_SESSION_BUS_ADDRESS: bus.address,
      };
      const t0 = performance.now();
      // Its own process group, so the WebKit processes stop with it.
      const proc = spawn(appBinary(), [], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
      try {
        return await new Promise((ok, fail) => {
          let err = "";
          const timer = setTimeout(() => fail(new Error(`no "page load started" within 60 s:\n${err}`)), 60_000);
          proc.once("error", fail);
          proc.stderr.on("data", (d) => {
            err += d;
            if (/page load started/.test(err)) {
              clearTimeout(timer);
              ok(Math.round(performance.now() - t0));
            }
          });
        });
      } finally {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          /* gone */
        }
        await sleep(500);
        bus.stop();
        profile.remove();
      }
    }

    /** ms from the page's start to the tree's mark, over STARTS starts. */
    async function pageTimes(name, kc, current) {
      const app = await launch(name, { kubeconfig: kc });
      const runs = [];
      try {
        for (let i = 0; i < STARTS; i++) {
          if (i > 0) await app.restart();
          const page = await app.waitFor(
            () => app.js(`return performance.getEntriesByName("nauvi:cluster-tree")[0]?.startTime ?? null`),
            { timeout: 60_000, message: "the cluster tree's mark" },
          );
          runs.push(Math.round(page));
          assert.equal(await nodeState(app, current), "visible");
        }
        await waitLive(app);
        await resizeWindow(app, 1280, 800);
        await app.shot(`${name}-tree`);
      } finally {
        await app.close();
      }
      return runs;
    }

    // A start under WebKitWebDriver takes about 30 s on the CI runner.
    it(`the tree shows within ${TREE_MS} ms, at most ${SLOWER_MS} ms slower than with 1 context`, { timeout: 15 * 60_000 }, async () => {
      const oneKc = kubeconfig("one", 1);
      const fiftyKc = [kubeconfig("a.yaml", 1, 16, "a"), kubeconfig("b.yaml", 0, 17, "b"), kubeconfig("c.yaml", 0, 16, "c")].join(":");
      const load = { one: [], fifty: [] };
      // Alternated, so a busy moment of the machine hits both.
      for (let i = 0; i < LOAD_STARTS; i++) {
        load.one.push(await untilPageLoads(oneKc));
        load.fifty.push(await untilPageLoads(fiftyKc));
      }
      const page = {
        one: await pageTimes("multicluster-start-1", oneKc, "budget-1"),
        fifty: await pageTimes("multicluster-start-50", fiftyKc, "a-1"),
      };
      const total = (k) => median(load[k]) + median(page[k]);
      const best = (k) => Math.min(...load[k]) + median(page[k]);
      const fifty = total("fifty");
      const slower = best("fifty") - best("one");
      report.startup = { load, page, total: { one: total("one"), fifty }, slower };
      const row = (label, k) =>
        `| ${label} | **${total(k)} ms** | ${median(load[k])} ms (${load[k].join(", ")}) | ${median(page[k])} ms (${page[k].join(", ")}) |`;
      summary(
        [
          `### Start-up with 50 contexts (ADR 0007, ${report.build} build)`,
          "",
          `Until the cluster tree shows. 50 contexts: 3 files, 49 unreachable. Medians; the slowdown compares the fastest start until the page loads (#369).`,
          "",
          "| Contexts | Total | App start until the page loads (no driver) | Page start until the tree shows |",
          "| ---: | ---: | ---: | ---: |",
          row("1", "one"),
          row("50", "fifty"),
          "",
          `Slower with 50: **${slower} ms** (budget ${SLOWER_MS} ms); 50 contexts: **${fifty} ms** (budget ${TREE_MS} ms).`,
          "",
        ].join("\n"),
      );
      if (ENFORCE) {
        assert.ok(fifty <= TREE_MS, `the tree showed after ${fifty} ms > ${TREE_MS} ms`);
        assert.ok(slower <= SLOWER_MS, `${slower} ms slower than with 1 context > ${SLOWER_MS} ms`);
      }
    });
  });
});
