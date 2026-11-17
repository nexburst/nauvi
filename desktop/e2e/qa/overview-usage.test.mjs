// The overview's limits and 1-hour usage chart (#328), in the real app
// against kind:
// - the CPU and Memory capacity bars show the limits, matching what kubectl
//   sums over the scheduled, unfinished pods, with a marker on the bar
// - Prometheus turned off in Settings: the chart samples metrics-server
//   while the window is open and says so; a second sample after the next
//   usage poll draws a line
// - with a Prometheus (qa.yml: QA_PROMETHEUS=1), the last hour from it
// - Hide metrics (#327) removes the chart (and shows the limits still)
// Light and dark theme at 1280x800. Reads the cluster only; the Settings
// changes stay in the app's own profile.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { kubectl } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 240_000 };
const TARGET = "monitoring/prometheus-server:http";

// As the UI formats them (lib/format.ts).
const trim = (n) => n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
const formatCpu = (m) => (m >= 1000 ? trim(m / 1000) : `${m}m`);
function formatMemory(bytes) {
  const units = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${bytes}B` : trim(v) + units[u];
}

function cpuOf(q) {
  if (!q) return 0;
  return q.endsWith("m") ? Number(q.slice(0, -1)) : Math.round(Number(q) * 1000);
}
function memOf(q) {
  if (!q) return 0;
  const m = /^([0-9.e+-]+)([A-Za-z]*)$/.exec(q);
  const mult = { "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return Math.round(Number(m[1]) * (mult[m[2]] ?? 1));
}

/** The limits kubectl sees, summed like the overview: scheduled, unfinished pods. */
function kubectlLimits() {
  const pods = JSON.parse(kubectl(["get", "pods", "-A", "-o", "json"])).items;
  let cpu = 0;
  let mem = 0;
  for (const p of pods) {
    if (!p.spec.nodeName || ["Succeeded", "Failed"].includes(p.status?.phase)) continue;
    const lim = (c) => c.resources?.limits ?? {};
    let c = 0;
    let m = 0;
    for (const x of p.spec.containers) {
      c += cpuOf(lim(x).cpu);
      m += memOf(lim(x).memory);
    }
    for (const x of p.spec.initContainers ?? []) {
      c = Math.max(c, cpuOf(lim(x).cpu));
      m = Math.max(m, memOf(lim(x).memory));
    }
    cpu += c + cpuOf(p.spec.overhead?.cpu);
    mem += m + memOf(p.spec.overhead?.memory);
  }
  return { cpu, mem };
}

const capacityText = (app) =>
  app.js(`return document.querySelector('section[aria-label="Capacity"]')?.innerText ?? ""`);

/** The chart's source line, note and points per chart. */
const usage = (app) =>
  app.js(`
    const u = document.querySelector('[data-testid="overview-usage"]');
    if (!u) return null;
    const pts = (r) => {
      const c = u.querySelector('[data-testid="usage-chart-' + r + '"]');
      const l = c?.querySelector('polyline[data-series="used"]');
      if (l) return (l.getAttribute('points') ?? '').trim().split(/\\s+/).filter(Boolean).length;
      return c?.querySelector('circle[data-series="used"]') ? 1 : 0;
    };
    return { source: u.querySelector('[data-testid="overview-usage-source"]')?.textContent.trim() ?? "",
             note: u.querySelector('[data-testid="overview-usage-note"]')?.textContent.trim() ?? "",
             cpu: pts("cpu"), memory: pts("memory") };`);

async function setPrometheus(app, value) {
  await app.palette("Settings", "Settings");
  await app.find(byTestId("prometheus-settings"));
  await app.setValue(await app.find(By.css('input[aria-label="Prometheus Service"]')), value);
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, {
    message: "Settings to close",
  });
}

async function setHidden(app, hidden) {
  await app.palette("cluster settings", "Cluster settings");
  const dialog = await app.find(byTestId("cluster-settings"));
  const box = await dialog.findElement(By.css('input[aria-label="Hide metrics"]'));
  if ((await box.isSelected()) !== hidden) await box.click();
  await app.waitFor(async () => (await box.isSelected()) === hidden, { message: `Hide metrics ${hidden}` });
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("cluster-settings"))).length === 0, {
    message: "the cluster settings to close",
  });
}

/** Leave the overview and come back: the chart asks the backend again at once. */
async function reopenOverview(app) {
  await app.nav("Pods");
  await app.nav("Overview");
}

describe("overview limits and usage chart", { timeout: 15 * 60_000 }, () => {
  const s = appSession("overview-usage");

  it("the capacity bars show the limits kubectl sums (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    // Pods come and go (other tests share the cluster): retry until a
    // reading of kubectl and the overview agree.
    const seen = await app.waitFor(
      async () => {
        const text = await capacityText(app);
        const { cpu, mem } = kubectlLimits();
        const lim = (v, fmt) => (v > 0 ? `${fmt(v)} limits (` : "no limits");
        const want = [lim(cpu, formatCpu), lim(mem, formatMemory)];
        return want.every((w) => text.includes(w)) ? { text, cpu, mem } : null;
      },
      { timeout: 90_000, interval: 3000, message: "the overview's limits to match kubectl's sums" },
    );
    console.log(`limits: cpu ${seen.cpu}m, memory ${seen.mem} B`);
    const markers = await app.driver.findElements(By.css('section[aria-label="Capacity"] .limit'));
    assert.ok(markers.length >= 1, "a limit marker on the bars");
  });

  it("Prometheus off: the chart samples metrics-server and says so (light)", T, async () => {
    const { app } = s;
    await setPrometheus(app, "off");
    await reopenOverview(app);
    const first = await app.waitFor(
      async () => {
        const u = await usage(app);
        return u?.source.startsWith("Sampled from metrics-server while this window is open") && u.cpu >= 1 ? u : null;
      },
      { timeout: 90_000, message: "the metrics-server chart" },
    );
    console.log(`metrics-server chart: ${JSON.stringify(first)}`);
    assert.equal(first.note, "");
    // The overview polls usage every 30 s: a second sample makes a line.
    const line = await app.waitFor(
      async () => {
        const u = await usage(app);
        return u && u.cpu >= 2 && u.memory >= 2 ? u : null;
      },
      { timeout: 120_000, interval: 2000, message: "a second metrics-server sample" },
    );
    console.log(`after the next poll: ${JSON.stringify(line)}`);
  });

  it("the same chart in the dark theme", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    const u = await usage(app);
    assert.ok(u && u.cpu >= 2, JSON.stringify(u));
  });

  it(
    "with a Prometheus: the last hour from it (dark)",
    { ...T, skip: process.env.QA_PROMETHEUS ? false : "set QA_PROMETHEUS=1 with a Prometheus installed (qa.yml)" },
    async () => {
      const { app } = s;
      await setPrometheus(app, "");
      await reopenOverview(app);
      const u = await app.waitFor(
        async () => {
          await reopenOverview(app);
          const v = await usage(app);
          return v?.source === `Last hour, from Prometheus (${TARGET}).` && v.cpu >= 2 && v.memory >= 2 ? v : null;
        },
        { timeout: 150_000, interval: 10_000, message: "the Prometheus chart with data" },
      );
      console.log(`prometheus chart: ${JSON.stringify(u)}`);
      assert.equal(u.note, "");
    },
  );

  it("the Prometheus chart in the light theme", { ...T, skip: process.env.QA_PROMETHEUS ? false : "no Prometheus" }, async () => {
    const { app } = s;
    await setTheme(app, "light");
    const u = await usage(app);
    assert.match(u?.source ?? "", /^Last hour, from Prometheus/);
  });

  it("hidden metrics: no chart, the limits stay (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await setHidden(app, true);
    await app.waitFor(async () => (await usage(app)) === null, { timeout: 30_000, message: "the chart to go" });
    assert.match(await capacityText(app), /limits/);
    await app.find(By.css('section[aria-label="Capacity"] [data-testid="metrics-hidden"]'));
  });

  it("shown again: the chart comes back (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await setHidden(app, false);
    await app.waitFor(async () => (await usage(app)) !== null, { timeout: 60_000, message: "the chart to come back" });
  });
});
