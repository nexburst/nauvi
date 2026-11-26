// Needs a Prometheus in the cluster: qa.yml applies
// scripts/test-cluster/prometheus.yaml (never on the shared local cluster)
// and sets QA_PROMETHEUS=1.
// Checks (#75): the pod and node charts come from the detected Prometheus
// with real 1h data.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { kubectl } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 120_000 };
const skip = process.env.QA_PROMETHEUS ? false : "set QA_PROMETHEUS=1 with a Prometheus installed (qa.yml)";
const TARGET = "monitoring/prometheus-server:http";

/** The chart source line and the CPU chart's point counts per series. */
async function charts(app) {
  return app.js(`
    const c = document.querySelector('[data-testid="detail-panel"] [data-testid="usage-charts"]');
    if (!c) return null;
    const cpu = c.querySelector('[data-testid="usage-chart-cpu"]');
    const series = {};
    for (const l of cpu?.querySelectorAll('polyline[data-series]') ?? [])
      series[l.dataset.series] = (l.getAttribute('points') ?? '').trim().split(/\\s+/).filter(Boolean).length;
    return { source: c.querySelector('[data-testid="usage-source"]')?.textContent.trim() ?? "",
             note: c.querySelector('[data-testid="usage-note"]')?.textContent.trim() ?? "", series };`);
}

async function waitForPrometheusCharts(app, what) {
  return app.waitFor(
    async () => {
      const c = await charts(app);
      return c?.source.startsWith(`From Prometheus (${TARGET})`) && Object.values(c.series).some((n) => n >= 2) ? c : null;
    },
    { timeout: 60_000, message: `Prometheus charts with data for ${what}` },
  );
}

describe("usage charts from Prometheus", { timeout: 10 * 60_000, skip }, () => {
  const s = appSession("prometheus");

  it("a pod's charts come from Prometheus", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", "demo", "multi");
    const c = await waitForPrometheusCharts(app, "demo/multi");
    console.log(`pod charts: ${JSON.stringify(c)}`);
    assert.equal(c.note, "");
  });

  it("a node's charts come from Prometheus", T, async () => {
    const { app } = s;
    const node = kubectl(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);
    await app.nav("Nodes");
    await app.filter(node);
    await app.clickRow(node);
    await app.find(byTestId("detail-panel"));
    await app.find(By.css('[data-testid="detail-panel"] [data-testid="usage-charts"]'));
    const c = await waitForPrometheusCharts(app, node);
    console.log(`node charts: ${JSON.stringify(c)}`);
  });
});
