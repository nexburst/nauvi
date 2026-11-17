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

/**
 * The limits kubectl sees, summed like the overview (and the scheduler):
 * scheduled, unfinished pods; app containers plus native sidecars, or the
 * largest init container (with the sidecars before it); plus overhead. And
 * how many running containers have no cpu / memory limit.
 */
function kubectlLimits() {
  const pods = JSON.parse(kubectl(["get", "pods", "-A", "-o", "json"])).items;
  let cpu = 0;
  let mem = 0;
  let cpuOpen = 0;
  let memOpen = 0;
  for (const p of pods) {
    if (!p.spec.nodeName || ["Succeeded", "Failed"].includes(p.status?.phase)) continue;
    const lim = (c) => c.resources?.limits ?? {};
    let sc = 0;
    let sm = 0;
    let ic = 0;
    let im = 0;
    const running = [...p.spec.containers];
    for (const x of p.spec.initContainers ?? []) {
      const c = cpuOf(lim(x).cpu);
      const m = memOf(lim(x).memory);
      if (x.restartPolicy === "Always") {
        running.push(x);
        sc += c;
        sm += m;
        ic = Math.max(ic, sc);
        im = Math.max(im, sm);
      } else {
        ic = Math.max(ic, c + sc);
        im = Math.max(im, m + sm);
      }
    }
    let ac = sc;
    let am = sm;
    for (const x of p.spec.containers) {
      ac += cpuOf(lim(x).cpu);
      am += memOf(lim(x).memory);
    }
    for (const x of running) {
      cpuOpen += lim(x).cpu ? 0 : 1;
      memOpen += lim(x).memory ? 0 : 1;
    }
    cpu += Math.max(ac, ic) + cpuOf(p.spec.overhead?.cpu);
    mem += Math.max(am, im) + memOf(p.spec.overhead?.memory);
  }
  return { cpu, mem, cpuOpen, memOpen };
}

/**
 * A pattern for the limits text of a bar, as `capacityBars` writes it:
 * "852Mi limits (3%) · 14 containers without a limit", or "no limits".
 */
function limitsPattern(v, open, fmt) {
  if (v === 0) return /no limits/;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const without = open > 0 ? ` · ${open} container${open === 1 ? "" : "s"} without a limit` : "";
  return new RegExp(`${esc(fmt(v))} limits \\(\\d+%\\)${esc(without)}(?! ·)`);
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
        const k = kubectlLimits();
        const want = [limitsPattern(k.cpu, k.cpuOpen, formatCpu), limitsPattern(k.mem, k.memOpen, formatMemory)];
        return want.every((w) => w.test(text)) ? { text, ...k } : null;
      },
      { timeout: 90_000, interval: 3000, message: "the overview's limits to match kubectl's sums" },
    );
    console.log(`limits: ${JSON.stringify(seen)}`);
    const markers = await app.driver.findElements(By.css('section[aria-label="Capacity"] .limit'));
    assert.ok(markers.length >= 1, "a limit marker on the bars");
    // Containers without a memory limit: the marker is hollow.
    if (seen.mem > 0 && seen.memOpen > 0) {
      await app.find(By.css('[data-testid="limit-Memory"].partial'));
    }
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
      // A young Prometheus may have no samples yet: reopen (which asks
      // again) every 30 s, reading the page in between.
      let reopened = Date.now();
      const u = await app.waitFor(
        async () => {
          if (Date.now() - reopened > 30_000) {
            await reopenOverview(app);
            reopened = Date.now();
          }
          const v = await usage(app);
          return v?.source === `Last hour, from Prometheus (${TARGET}).` && v.cpu >= 2 && v.memory >= 2 ? v : null;
        },
        { timeout: 150_000, interval: 2000, message: "the Prometheus chart with data" },
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
