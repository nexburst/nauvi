// Area 3 of #83, PR #75 (usage history from Prometheus) and PR #92
// (workload charts from Prometheus):
// Always (no Prometheus needed):
// - Settings > Prometheus says what it found for the context
// - a Prometheus Service set in Settings that does not exist: the charts fall
//   back to metrics-server and say why; clearing it goes back to detection
// With a Prometheus (qa.yml applies scripts/test-cluster/prometheus.yaml,
// never on the shared local cluster, and sets QA_PROMETHEUS=1):
// - a pod's charts offer Live/1h/6h/24h; 1h, 6h and 24h come from Prometheus
// - a node's and a Deployment's (all its pods) charts come from Prometheus
// - the charts in the light theme

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { kubectl } from "../lib/cluster.mjs";
import { openClusterDetail, scrollPanelTo, setTheme, usageCharts } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const withProm = process.env.QA_PROMETHEUS ? false : "set QA_PROMETHEUS=1 with a Prometheus installed (qa.yml)";
const TARGET = "monitoring/prometheus-server:http";
const BOGUS = "qa-area3-none/prometheus:9090";

async function openSettings(app) {
  await app.palette("Settings", "Settings");
  return app.find(byTestId("prometheus-settings"));
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, {
    message: "Settings to close",
  });
}

function promStatus(app) {
  return app.js(`return document.querySelector('[data-testid="prometheus-status"]')?.textContent.trim() ?? ""`);
}

async function setPrometheus(app, value) {
  await app.setValue(await app.find(By.css('input[aria-label="Prometheus Service"]')), value);
}

async function clickRange(app, label) {
  const b = await app.find(
    By.xpath(`//*[@data-testid='detail-panel']//*[@aria-label='Usage range']//button[normalize-space()='${label}']`),
  );
  await b.click();
}

/**
 * Wait for Prometheus charts over `range` with data: a line over 1h; over
 * 6h and 24h a young Prometheus (minutes old in CI) may have one step only.
 */
function waitProm(app, range, what) {
  const min = range === "1h" ? 2 : 1;
  return app.waitFor(
    async () => {
      const u = await usageCharts(app);
      const ok =
        u?.source === `From Prometheus (${TARGET}), last ${range}.` &&
        Object.values(u.cpu?.series ?? {}).some((n) => n >= min) &&
        Object.values(u.memory?.series ?? {}).some((n) => n >= min);
      return ok ? u : null;
    },
    { timeout: 90_000, interval: 1000, message: `Prometheus ${range} charts with data for ${what}` },
  );
}

describe("area 3: Prometheus settings and fallback (#75)", { timeout: 10 * 60_000 }, () => {
  const s = appSession("area-3-prometheus-fallback");

  it("Settings > Prometheus says what was found for the context", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await openSettings(app);
    const status = await app.waitFor(
      async () => {
        const t = await promStatus(app);
        return t && t !== "Checking…" ? t : null;
      },
      { timeout: 30_000, message: "the Prometheus status" },
    );
    console.log(`prometheus status: ${status}`);
    if (process.env.QA_PROMETHEUS) assert.equal(status, `Using ${TARGET} (detected).`);
    else assert.doesNotMatch(status, /^Using /);
  });

  it("a Service set in Settings that does not exist: the charts fall back and say why", T, async () => {
    const { app } = s;
    const detected = await promStatus(app);
    await setPrometheus(app, BOGUS);
    // The dialog checks again once the setting is saved; the status should
    // then be about the Service that was set.
    const status = await app
      .waitFor(
        async () => {
          const t = await promStatus(app);
          return t && t !== "Checking…" && t !== detected ? t : null;
        },
        { timeout: 20_000, message: "the status for the set Service" },
      )
      .catch(() => promStatus(app));
    console.log(`status with ${BOGUS}: ${status}`);
    await app.shot("settings-with-a-missing-service");
    await closeSettings(app);
    await app.openDetail("Pods", "demo", "multi");
    const u = await app.waitFor(
      async () => {
        const v = await usageCharts(app);
        return v && (v.note || v.source || v.since) && !v.text.includes("Loading") ? v : null;
      },
      { timeout: 60_000, message: "the charts with the set Service" },
    );
    console.log(`charts with ${BOGUS}: ${JSON.stringify({ ...u, text: undefined })}`);
    // Either the charts never try Prometheus (the status says it is missing),
    // or they try, fail, and say why.
    if (u.ranges.length > 0) {
      await clickRange(app, "1h");
      const f = await app.waitFor(
        async () => {
          const v = await usageCharts(app);
          return v?.note ? v : null;
        },
        { timeout: 60_000, message: "the fallback note" },
      );
      console.log(`after 1h: ${JSON.stringify({ ...f, text: undefined })}`);
      assert.match(f.note, /Showing the metrics-server history instead\.$/);
      assert.ok(f.since.startsWith("Collecting since"), "the metrics-server history is shown");
    } else {
      assert.ok(u.since.startsWith("Collecting since") || u.empty, "metrics-server history");
    }
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
    assert.ok(status.includes(BOGUS), `Settings names the Service set there: "${status}"`);
  });

  it("clearing the setting goes back to detection", T, async () => {
    const { app } = s;
    await openSettings(app);
    await setPrometheus(app, "");
    const status = await app.waitFor(
      async () => {
        const t = await promStatus(app);
        return t && t !== "Checking…" && !t.includes(BOGUS) ? t : null;
      },
      { timeout: 30_000, message: "the status after clearing" },
    );
    console.log(`status after clearing: ${status}`);
    assert.ok(!status.includes("from Settings"));
    await closeSettings(app);
  });
});

describe("area 3: usage charts from Prometheus (#75, #92)", { timeout: 10 * 60_000, skip: withProm }, () => {
  const s = appSession("area-3-prometheus");

  it("a pod: Live/1h/6h/24h, and 1h, 6h, 24h come from Prometheus", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.openDetail("Pods", "demo", "multi");
    const first = await app.waitFor(async () => {
      const u = await usageCharts(app);
      return u?.ranges.length ? u : null;
    }, { timeout: 60_000, message: "range buttons" });
    assert.deepEqual(first.ranges.map((r) => r.label), ["Live", "1h", "6h", "24h"]);
    for (const r of ["1h", "6h", "24h"]) {
      await clickRange(app, r);
      const u = await waitProm(app, r, `demo/multi ${r}`);
      console.log(`multi ${r}: ${JSON.stringify({ ...u, text: undefined })}`);
      assert.equal(u.note, "");
      assert.ok(u.ranges.find((x) => x.label === r).active);
      assert.ok(Object.keys(u.cpu.series).includes("app"), "per-container lines");
    }
    await clickRange(app, "1h");
    await waitProm(app, "1h", "demo/multi");
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });

  it("a node's charts come from Prometheus", T, async () => {
    const { app } = s;
    const node = kubectl(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);
    await openClusterDetail(app, "Nodes", node);
    await app.waitFor(async () => (await usageCharts(app))?.ranges.length, { timeout: 60_000, message: "ranges" });
    await clickRange(app, "1h");
    const u = await waitProm(app, "1h", node);
    console.log(`node: ${JSON.stringify({ ...u, text: undefined })}`);
    assert.deepEqual(u.cpu.refs, ["allocatable"]);
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });

  it("a Deployment's charts (all its pods) come from Prometheus", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", "demo", "web");
    await app.waitFor(async () => (await usageCharts(app))?.ranges.length, { timeout: 60_000, message: "ranges" });
    await clickRange(app, "6h");
    const u = await waitProm(app, "6h", "demo/web");
    console.log(`deployment: ${JSON.stringify({ ...u, text: undefined })}`);
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });

  it("the Prometheus charts in the light theme", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.openDetail("Pods", "demo", "multi");
    await app.waitFor(async () => (await usageCharts(app))?.ranges.length, { timeout: 60_000, message: "ranges" });
    await clickRange(app, "1h");
    await waitProm(app, "1h", "demo/multi (light)");
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });
});
