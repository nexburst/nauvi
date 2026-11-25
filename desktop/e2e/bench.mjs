// 10k-row table benchmark in the real WebKitGTK webview, with budgets (#115).
//
// Serves desktop/ui-src with Vite, points the app's webview at bench.html,
// clicks Fill, Start churn and Auto scroll, samples the page's stats (2 s
// windows) for BENCH_SECONDS, and writes them to the console, to
// artifacts/bench.json and, on GitHub Actions, to the job summary.
//
// It exits non-zero when it could not measure, or when a number is over
// its limit in BUDGET (BENCH_BUDGET=off: report only). integration.yml runs
// it on every PR, so a regression fails the PR.

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { By } from "selenium-webdriver";
import { ARTIFACTS, E2E_DIR, launch, xq } from "./lib/app.mjs";

const SECONDS = Number(process.env.BENCH_SECONDS || 30);
const PORT = Number(process.env.BENCH_PORT || 1420);
const URL = `http://localhost:${PORT}/bench.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startVite() {
  // Vite's own entry rather than `npx vite`: killing npx would leave Vite
  // running and holding our pipes open.
  const ui = resolve(E2E_DIR, "../ui-src");
  const vite = join(ui, "node_modules/vite/bin/vite.js");
  const proc = spawn(process.execPath, [vite, "--port", String(PORT), "--strictPort"], {
    cwd: ui,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`vite exited:\n${out}`);
    try {
      if ((await fetch(URL)).ok) return proc;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`vite did not serve ${URL}:\n${out}`);
    }
    await sleep(300);
  }
}

const num = (text, re) => {
  const m = text.match(re);
  return m ? Number(m[1]) : NaN;
};

function parseStats(spans) {
  const all = spans.join(" | ");
  return {
    fps: num(all, /([\d.]+) fps/),
    p95Frame: num(all, /frame p95 ([\d.]+) ms/),
    maxFrame: num(all, /frame max ([\d.]+) ms/),
    longFrames: num(all, /frames >33 ms: (\d+)/),
    batchMean: num(all, /batch apply\+render mean ([\d.]+) ms/),
    batchP95: num(all, /p95 ([\d.]+) ms, max/),
    batchMax: num(all, /, max ([\d.]+) ms$/),
  };
}

/**
 * The limits, about 2.5-3x over the slowest of 25 CI runs on main and PRs
 * (debug build, Xvfb, no GPU, 2026-11-25): snapshot 46-95 ms, batch
 * apply+render mean 9-19 ms and worst-window p95 17-46 ms, frame p95 23-42
 * ms (median window), fps 54-62 (median window). `max` keys are upper
 * limits, `min` keys lower ones. Report-only, too noisy for a limit on one
 * runner: frame max (40-80 ms), the worst window's fps and frame p95, and
 * the count of frames over 33 ms (21-129).
 */
const BUDGET = {
  max: { fillMs: 250, batchMeanMedian: 50, batchP95Worst: 120, frameP95Median: 100 },
  min: { fpsMedian: 30 },
};

/** "key value > limit" for every number past its limit (none when off). */
function overBudget(s) {
  if (process.env.BENCH_BUDGET === "off") return [];
  const over = Object.entries(BUDGET.max)
    .filter(([k, limit]) => !(s[k] <= limit))
    .map(([k, limit]) => `${k} ${s[k]} > ${limit}`);
  const under = Object.entries(BUDGET.min)
    .filter(([k, limit]) => !(s[k] >= limit))
    .map(([k, limit]) => `${k} ${s[k]} < ${limit}`);
  return [...over, ...under];
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const max = (xs) => Math.max(...xs.filter(Number.isFinite));

async function main() {
  const vite = await startVite();
  const app = await launch("bench");
  try {
    const { driver } = app;
    await driver.get(URL);
    const button = (label) => app.find(By.xpath(`//button[normalize-space()=${xq(label)}]`));
    const statSpans = () => app.js(`return Array.from(document.querySelectorAll(".stats span"), (s) => s.textContent.trim())`);

    await (await button("Fill (snapshot)")).click();
    const rows = await app.waitFor(
      async () => {
        const [first] = await statSpans();
        const m = first?.match(/^(\d+) of (\d+) rows/);
        return m && Number(m[2]) >= 10_000 ? Number(m[2]) : null;
      },
      { timeout: 30_000, message: "10k rows" },
    );
    const fillLog = await app.js(
      `return Array.from(document.querySelectorAll(".log div"), (d) => d.textContent).find((t) => t.includes("snapshot of")) ?? ""`,
    );
    const fillMs = num(fillLog, /rendered in ([\d.]+) ms/);
    await (await button("Start churn")).click();
    await (await button("Auto scroll")).click();
    await app.shot("running");

    // The page publishes stats for 2 s windows; sample each window.
    const samples = [];
    await sleep(2500); // skip the window that contains the clicks
    const end = Date.now() + SECONDS * 1000;
    while (Date.now() < end) {
      await sleep(2000);
      samples.push(parseStats(await statSpans()));
    }
    await app.shot("end");
    const userAgent = await app.js("return navigator.userAgent");

    const summary = {
      rows,
      seconds: SECONDS,
      windows: samples.length,
      fillMs,
      fpsMedian: median(samples.map((s) => s.fps)),
      fpsMin: Math.min(...samples.map((s) => s.fps).filter(Number.isFinite)),
      frameP95Median: median(samples.map((s) => s.p95Frame)),
      frameP95Worst: max(samples.map((s) => s.p95Frame)),
      frameMax: max(samples.map((s) => s.maxFrame)),
      longFrames: samples.reduce((a, s) => a + (s.longFrames || 0), 0),
      batchMeanMedian: median(samples.map((s) => s.batchMean)),
      batchP95Worst: max(samples.map((s) => s.batchP95)),
      batchMax: max(samples.map((s) => s.batchMax)),
      userAgent,
      env: {
        WEBKIT_DISABLE_COMPOSITING_MODE: process.env.WEBKIT_DISABLE_COMPOSITING_MODE ?? "",
        LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE ?? "",
      },
      samples,
    };
    summary.overBudget = overBudget(summary);
    writeFileSync(join(ARTIFACTS, "bench.json"), JSON.stringify(summary, null, 2));
    report(summary);
    if (summary.overBudget.length) throw new OverBudget(summary.overBudget);
  } finally {
    await app.close();
    vite.kill();
  }
}

function report(s) {
  const md = [
    `### Table benchmark (WebKitGTK${process.env.CI ? ", CI runner under Xvfb, no GPU" : ""})`,
    "",
    `${s.rows.toLocaleString("en")} rows, churn 200 changes every 200 ms, auto scroll, ${s.seconds} s (${s.windows} windows of 2 s).`,
    "",
    "| metric | value |",
    "| --- | --- |",
    `| snapshot apply+render (10k rows) | ${s.fillMs} ms |`,
    `| fps (median / worst window) | ${s.fpsMedian} / ${s.fpsMin} |`,
    `| frame p95 (median / worst window) | ${s.frameP95Median} / ${s.frameP95Worst} ms |`,
    `| frame max | ${s.frameMax} ms |`,
    `| frames > 33 ms (total) | ${s.longFrames} |`,
    `| batch apply+render mean (median window) | ${s.batchMeanMedian} ms |`,
    `| batch apply+render p95 (worst window) / max | ${s.batchP95Worst} / ${s.batchMax} ms |`,
    "",
    `<sub>${s.userAgent}</sub>`,
    "",
    s.overBudget.length
      ? `**Over budget:** ${s.overBudget.join(", ")}.`
      : process.env.BENCH_BUDGET === "off"
        ? "Budgets off (BENCH_BUDGET=off)."
        : "Within budget.",
    "",
    `Limits (BUDGET in desktop/e2e/bench.mjs): snapshot <= ${BUDGET.max.fillMs} ms, batch mean <= ${BUDGET.max.batchMeanMedian} ms, ` +
      `batch p95 <= ${BUDGET.max.batchP95Worst} ms, frame p95 <= ${BUDGET.max.frameP95Median} ms, fps >= ${BUDGET.min.fpsMedian}. ` +
      "CI runners have no GPU, so the numbers are pessimistic; frame max and the worst window are report-only.",
    "",
  ].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

/** The run measured, and some number is past its limit. */
class OverBudget extends Error {
  constructor(over) {
    super(`over budget: ${over.join(", ")}`);
  }
}

// Exit explicitly: a leftover child (driver, webview, Vite) must not keep the
// process, and so the CI step, alive.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    // Over budget: the report above already says so.
    if (e instanceof OverBudget) process.exit(1);
    const msg = `### Table benchmark\n\nCould not measure: \`${String(e.message ?? e).split("\n")[0]}\`\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, msg);
    process.exit(1);
  },
);
