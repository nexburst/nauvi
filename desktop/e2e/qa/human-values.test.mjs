// Human-readable values (#484), at 1280x800 in the dark and the light theme:
// - the Overview's problem pods say how long a pod is pending in days and
//   hours ("Pending for 8d 14h"), never minutes over an hour ("12382m");
//   the demo's default/hungry asks for 1000 CPUs and stays pending
// - its detail panel's events read "Failed scheduling" (the raw reason in
//   the tooltip), a summary line ("No node has enough CPU and memory") over
//   the scheduler's full message, and "N times, last 41s ago"
// - the Pods table's Memory reads "5.5 MiB" and the CPU tooltip the cores
//   (skipped without metrics-server)
//
// Reads the shared demo objects only; changes nothing in the cluster.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kubectl } from "../lib/cluster.mjs";
import { panelText, scrollPanelTo, setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { cell, openKind } from "./area-2-helpers.mjs";

const T = { timeout: 480_000 };
const PROBLEMS = '.overview section[aria-label="Problem pods"]';
/** "45s", "3m 5s", "3h 5m", "8d 14h", "1y 20d". */
const DURATION = /^\d+[smhdy]( \d+[smhdy])?$/;

const frame = (app) =>
  app.driver.executeAsyncScript(
    "const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(() => done()))",
  );

async function shotBoth(app, name) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await frame(app);
    await app.shot(`${name}-${theme}`);
  }
  await setTheme(app, null);
}

describe("human-readable values (#484)", { timeout: 15 * 60_000 }, () => {
  const s = appSession("human-values");

  it("the Overview says how long default/hungry is pending in days and hours", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    kubectl(["-n", "default", "get", "pod", "hungry"]);
    await app.nav("Overview");
    // A pending pod is a problem after five minutes; on a fresh CI cluster
    // that may still be ahead.
    const reason = await app.waitFor(
      () =>
        app.js(
          `const p = Array.from(document.querySelectorAll('${PROBLEMS} .problem'))
             .find((el) => el.querySelector("button, span")?.textContent.trim() === "default/hungry");
           return p?.querySelector(".reason")?.textContent.trim() ?? null;`,
        ),
      { timeout: 420_000, interval: 2000, message: "default/hungry in the problem pods" },
    );
    console.log(`problem: ${reason}`);
    const m = /^Pending for (.+)$/.exec(reason);
    assert.ok(m, `"${reason}" says Pending for <duration>`);
    assert.match(m[1], DURATION);
    assert.doesNotMatch(reason, /\d{3,}m/, "no minutes over an hour");
    await app.js(`document.querySelector('${PROBLEMS}')?.scrollIntoView({ block: "start" })`);
    await shotBoth(app, "overview-problems");
  });

  it("the pod's events say the reason in words, a summary, how often and when", T, async () => {
    const { app } = s;
    await app.js(
      `Array.from(document.querySelectorAll('${PROBLEMS} .problem button'))
         .find((b) => b.textContent.trim() === "default/hungry")?.click()`,
    );
    await waitPanelTitle(app, "hungry");
    const events = await app.waitFor(
      () =>
        app.js(`
          const t = document.querySelector('[data-testid="detail-panel"] table.events');
          if (!t) return null;
          return Array.from(t.querySelectorAll("tbody tr"), (tr) => ({
            reason: tr.cells[1].textContent.trim(),
            raw: tr.cells[1].getAttribute("title"),
            summary: tr.querySelector(".summary")?.textContent.trim() ?? "",
            full: tr.querySelector(".full")?.textContent.trim() ?? "",
            seen: tr.cells[3].textContent.trim(),
          }));`),
      { timeout: 60_000, interval: 1000, message: "the events of default/hungry" },
    );
    console.log(JSON.stringify(events, null, 2));
    const e = events.find((x) => x.raw === "FailedScheduling");
    assert.ok(e, "a FailedScheduling event");
    assert.equal(e.reason, "Failed scheduling");
    // 1000 CPUs and 100Gi: no node has enough of either. With a tainted
    // control-plane node (CI's two-node cluster) the taint is named too.
    assert.match(e.summary, /^No node (has enough CPU and memory|fits: .*short of CPU and memory)/);
    assert.match(e.full, /^0\/\d+ nodes are available/);
    assert.match(e.seen, /^(\d+ times, last )?\d+[smhdy]( \d+[smhdy])? ago$/);
    await scrollPanelTo(app, "table.events");
    await shotBoth(app, "hungry-events");
    assert.ok((await panelText(app)).includes(e.summary));
  });

  it("the Pods table shows memory in MiB and CPU in cores in the tooltip", T, async (t) => {
    const { app } = s;
    await openKind(app, "Pods", "demo", "web");
    const web = kubectl(["-n", "demo", "get", "pods", "-l", "app=web", "-o", "jsonpath={.items[0].metadata.name}"]);
    const mem = await app
      .waitFor(
        async () => {
          const v = await cell(app, web, "Memory");
          return v && v !== "—" ? v : null;
        },
        { timeout: 90_000, interval: 2000, message: "a Memory cell" },
      )
      .catch(() => null);
    if (!mem) {
      t.skip("no pod metrics (metrics-server) in this cluster");
      return;
    }
    console.log(`memory: ${mem}`);
    assert.match(mem, /^\d+(\.\d)? (B|KiB|MiB|GiB)$/);
    const cpuTitle = await app.js(
      `const heads = Array.from(document.querySelectorAll('[data-testid="resource-table"] [role="columnheader"]'),
         (h) => h.textContent.replace(/[▲▼]/g, "").trim());
       const i = heads.indexOf("CPU");
       for (const r of document.querySelectorAll('[data-testid="resource-row"]')) {
         const c = r.querySelectorAll('[role="gridcell"]');
         if (c[1]?.textContent.trim() === arguments[0]) return c[i]?.getAttribute("title") ?? null;
       }
       return null;`,
      web,
    );
    console.log(`cpu title: ${cpuTitle}`);
    // "250m (0.25 cores)"; an idle pod reads "0m (0 cores)".
    assert.match(cpuTitle, /^\d+m? \(\d+(\.\d+)? cores?\)/);
    await shotBoth(app, "pods-memory");
  });
});
