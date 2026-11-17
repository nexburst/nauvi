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
// (a TEST-NET address), against 1 context. The tree must show (the
// `nauvi:cluster-tree` mark ClusterTree sets when it first lists contexts)
// within TREE_MS of the app's start (the fastest of 5 starts), and from the
// page's start at most SLOWER_MS later than with 1 context (the median).
//
// Why the slowdown is taken from the page's start: under WebKitWebDriver
// the page starts loading when the driver has attached, which lands on
// steps about 500 ms apart. A few ms more in the core's setup (reading 50
// contexts) can move it to the next step: 465 vs 980 ms until the page
// loads, every start, while launched without the driver both start the
// page at about 560 ms. So the time until the page loads is mostly the
// driver's, and only the total (TREE_MS) includes it.
//
// A release build (QA_RELEASE_APP, which qa.yml builds for this scenario)
// is measured when there is one; otherwise the debug build, and the report
// says so. The numbers go to the console, artifacts/multicluster.json and,
// on GitHub Actions, the job summary. QA_MEMORY_BUDGET=off reports without
// failing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { ARTIFACTS, CONTEXT, launch } from "../lib/app.mjs";
import { appPid } from "../lib/dock.mjs";
import { measure } from "../lib/memory.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { expandCluster, nodeState, nodeText, waitNodeState } from "../lib/tree.mjs";
import { resizeWindow } from "../lib/window.mjs";

/** Budgets (ADR 0007). */
const MB_PER_CLUSTER = 15;
const TREE_MS = 1500;
const SLOWER_MS = 200;
const STARTS = 5;

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
    /** Epoch ms the process `pid` started at (10 ms ticks). */
    function startedAt(pid) {
      const btime = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)/m)[1]);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      return btime * 1000 + ticks * 10;
    }

    /**
     * ms from the app's start (process start time) and from the page's
     * (navigation start) to the tree's mark, over STARTS starts: the
     * fastest total and the median page time.
     */
    async function treeTimes(name, kc, current) {
      const app = await launch(name, { kubeconfig: kc });
      const runs = [];
      try {
        for (let i = 0; i < STARTS; i++) {
          if (i > 0) await app.restart();
          const mark = await app.waitFor(
            () =>
              app.js(`const m = performance.getEntriesByName("nauvi:cluster-tree")[0];
                      return m ? { page: m.startTime, origin: performance.timeOrigin } : null;`),
            { timeout: 60_000, message: "the cluster tree's mark" },
          );
          const pid = appPid(app.profile.home);
          assert.ok(pid, "found the app's process");
          const load = mark.origin - startedAt(pid);
          runs.push({ app: Math.round(load + mark.page), load: Math.round(load), page: Math.round(mark.page) });
          assert.equal(await nodeState(app, current), "visible");
        }
        await waitLive(app);
        await resizeWindow(app, 1280, 800);
        await app.shot(`${name}-tree`);
      } finally {
        await app.close();
      }
      return { runs, app: Math.min(...runs.map((r) => r.app)), page: median(runs.map((r) => r.page)) };
    }

    // A start under WebKitWebDriver takes about 30 s on the CI runner (start, attach, quit).
    it(`the tree shows within ${TREE_MS} ms, at most ${SLOWER_MS} ms slower than with 1 context`, { timeout: 15 * 60_000 }, async () => {
      const one = await treeTimes("multicluster-start-1", kubeconfig("one", 1), "budget-1");
      const fifty = [kubeconfig("a.yaml", 1, 16, "a"), kubeconfig("b.yaml", 0, 17, "b"), kubeconfig("c.yaml", 0, 16, "c")];
      const many = await treeTimes("multicluster-start-50", fifty.join(":"), "a-1");
      report.startup = { one, fifty: many };
      const row = (label, r) =>
        `| ${label} | ${r.app} ms | ${r.page} ms | ${r.runs.map((x) => `${x.app} (${x.load} + ${x.page})`).join(", ")} |`;
      summary(
        [
          `### Start-up with 50 contexts (ADR 0007, ${report.build} build)`,
          "",
          `Until the cluster tree shows, over ${STARTS} starts. 50 contexts: 3 files, 49 unreachable. ` +
            "The time until the page loads is mostly WebKitWebDriver attaching (steps of about 500 ms).",
          "",
          "| Contexts | From the app's start (fastest) | From the page's start (median) | Each start, ms: total (until the page loads + page) |",
          "| ---: | ---: | ---: | --- |",
          row("1", one),
          row("50", many),
          "",
          `Slower with 50, from the page's start: **${many.page - one.page} ms** (budget ${SLOWER_MS} ms); ` +
            `50 contexts: **${many.app} ms** (budget ${TREE_MS} ms).`,
          "",
        ].join("\n"),
      );
      if (ENFORCE) {
        assert.ok(many.app <= TREE_MS, `the tree showed after ${many.app} ms > ${TREE_MS} ms`);
        assert.ok(many.page - one.page <= SLOWER_MS, `${many.page - one.page} ms slower than with 1 context > ${SLOWER_MS} ms`);
      }
    });
  });
});
