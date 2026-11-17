// Throughput probes for the stream-perf scenario (#115): an in-page frame
// recorder that also notes when a condition first holds, the CPU time of
// the app's processes (/proc, Linux) and their peak memory.

import { readFileSync } from "node:fs";
import { measure } from "./memory.mjs";

const TICKS_PER_S = 100; // USER_HZ on Linux

/**
 * Start recording frames in the page. `done` says when the work is visible
 * (checked every frame; the app's CSP allows no eval, so it is data):
 *   { selector, text }       some element matching `selector` contains `text`
 *   { selector, attr, value } some match has `attr` equal to `value`
 * Call `go()` right before starting the work, then `result()` after `waitDone()`.
 */
export async function frameProbe(app, done) {
  await app.js(
    `const d = arguments[0];
     const check = () => {
       if (d.text !== undefined) {
         for (const el of document.querySelectorAll(d.selector)) if (el.textContent.includes(d.text)) return true;
         return false;
       }
       for (const el of document.querySelectorAll(d.selector)) if (el.getAttribute(d.attr) === d.value) return true;
       return false;
     };
     const p = (window.__qaPerf = { frames: [], go: 0, doneAt: 0, stop: false });
     const tick = (t) => {
       if (p.go) {
         p.frames.push(t);
         if (!p.doneAt && check()) p.doneAt = t;
       }
       if (!p.stop) requestAnimationFrame(tick);
     };
     requestAnimationFrame(tick);`,
    done,
  );
  return {
    go: () => app.js("window.__qaPerf.go = performance.now()"),
    waitDone: (timeout, message) =>
      app.waitFor(() => app.js("return window.__qaPerf.doneAt > 0"), { timeout, interval: 200, message }),
    async result() {
      const r = await app.js(`
        const p = window.__qaPerf;
        p.stop = true;
        const end = p.doneAt || performance.now();
        const ts = p.frames.filter((t) => t <= end);
        const gaps = [];
        for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
        return { go: p.go, doneAt: p.doneAt, gaps };`);
      const gaps = [...r.gaps].sort((a, b) => a - b);
      const at = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] : 0);
      const span = r.doneAt ? r.doneAt - r.go : NaN;
      // Time beyond a 60 Hz frame, summed: roughly how long the main thread
      // kept frames from being drawn.
      const blocked = gaps.reduce((n, g) => n + Math.max(0, g - 1000 / 60), 0);
      return {
        ms: Math.round(span),
        frames: gaps.length,
        fps: gaps.length && span ? +((gaps.length * 1000) / span).toFixed(1) : 0,
        p50Frame: +at(0.5).toFixed(1),
        p95Frame: +at(0.95).toFixed(1),
        maxFrame: +(gaps.at(-1) ?? 0).toFixed(1),
        longFrames: gaps.filter((g) => g > 50).length,
        blockedPct: span ? +((100 * blocked) / span).toFixed(1) : NaN,
      };
    },
  };
}

/** utime + stime of `pid` in clock ticks, or 0. */
function ticks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Fields 14 and 15 of stat; f[0] is field 3.
    return Number(f[11]) + Number(f[12]);
  } catch {
    return 0;
  }
}

/** CPU seconds of the core and of the WebKitWebProcesses under it so far. */
export function cpuSeconds(root) {
  const m = measure(root);
  const web = m.processes.filter((p) => p.comm.startsWith("WebKitWebProc")).map((p) => p.pid);
  const sum = (pids) => pids.reduce((n, p) => n + ticks(p), 0) / TICKS_PER_S;
  return { core: sum([root]), web: sum(web) };
}

/** Sample memory every `everyMs` until `stop()`; returns the peaks, MB. */
export function peakMemory(root, everyMs = 300) {
  const peak = { coreRss: 0, webRss: 0, coreAndWebRss: 0 };
  const sample = () => {
    const m = measure(root);
    peak.coreRss = Math.max(peak.coreRss, m.core.rss);
    peak.webRss = Math.max(peak.webRss, m.web.rss);
    peak.coreAndWebRss = Math.max(peak.coreAndWebRss, m.coreAndWeb.rss);
  };
  sample();
  const timer = setInterval(sample, everyMs);
  return {
    stop() {
      clearInterval(timer);
      sample();
      const mb = (k) => Math.round(k / 1024);
      return { coreRssMb: mb(peak.coreRss), webRssMb: mb(peak.webRss), coreAndWebRssMb: mb(peak.coreAndWebRss) };
    },
  };
}

/** Run `work` with frames, CPU and peak memory measured around it. */
export async function measured(app, pid, done, work, { timeout = 120_000, message = "the work to show" } = {}) {
  const probe = await frameProbe(app, done);
  const mem = peakMemory(pid);
  const cpu0 = cpuSeconds(pid);
  const t0 = Date.now();
  await probe.go();
  let memory;
  try {
    await work();
    await probe.waitDone(timeout, message);
  } finally {
    memory = mem.stop();
  }
  const wallMs = Date.now() - t0;
  const cpu1 = cpuSeconds(pid);
  const frames = await probe.result();
  return {
    wallMs,
    ...frames,
    coreCpuS: +(cpu1.core - cpu0.core).toFixed(2),
    webCpuS: +(cpu1.web - cpu0.web).toFixed(2),
    ...memory,
  };
}
