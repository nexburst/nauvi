import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

// The overview's limits and its 1-hour CPU and memory chart (#328): from
// Prometheus when there is one, else sampled from metrics-server while the
// window is open; nothing while metrics are hidden (#327).

const capacity = (page: Page) => page.getByRole("region", { name: "Capacity" });
const usage = (page: Page) => page.getByTestId("overview-usage");

// Init functions run in the page as source text: no captured variables.
const hideDev = (cluster: FakeCluster) => {
  cluster.settings.contexts["kind-dev"] = {
    view: "",
    namespaces: [],
    typed_namespaces: [],
    prometheus: "",
    display_name: "",
    color: "",
    default_namespace: "",
    shell_cwd: "",
    last_used: 0,
    hide_metrics: true,
  };
};

test("the capacity bars show the limits, with a marker", async ({ page }) => {
  const fake = await openApp(page);
  await expect(capacity(page)).toContainText("1.2 / 8 requested (15%)");
  await expect(capacity(page)).toContainText("2.5 limits (31%)");
  // Three containers have no memory limit: said, and the marker is hollow.
  await expect(capacity(page)).toContainText("6Gi limits (38%) · 3 containers without a limit");
  await expect(capacity(page).getByTestId("limit-Memory")).toHaveClass(/partial/);
  await expect(capacity(page).getByTestId("limit-CPU")).not.toHaveClass(/partial/);
  await expect(capacity(page).getByTestId("limit-CPU")).toHaveAttribute("style", /left: 31%/);
  await expect(capacity(page).locator(".bar-limits.over")).toHaveCount(0);

  // Limits over allocatable: overcommitted, the marker at the end, in red.
  const c = (await page.evaluate(() => window.__fake.cluster.overview.capacity))!;
  await fake.emitOverview({ capacity: { ...c, memory_limits_bytes: 20 * 1024 ** 3 } });
  await expect(capacity(page)).toContainText("20Gi limits (125%)");
  await expect(capacity(page).getByTestId("limit-Memory")).toHaveClass(/over/);
  await expect(capacity(page).getByTestId("limit-Memory")).toHaveAttribute("style", /left: 100%/);
  expect(fake.errors).toEqual([]);
});

test("without Prometheus, the chart samples metrics-server while the window is open", async ({ page }) => {
  await page.clock.install();
  const fake = await openApp(page);
  await expect(usage(page).getByTestId("overview-usage-source")).toHaveText(
    /^Sampled from metrics-server while this window is open, since \d\d:\d\d \(at most an hour\)\.$/,
  );
  await expect(usage(page).getByTestId("overview-usage-note")).toHaveCount(0);
  const cpu = usage(page).getByTestId("usage-chart-cpu");
  // One sample so far: a dot.
  await expect(cpu.locator('circle[data-series="used"]')).toHaveCount(1);
  await expect(cpu).toContainText("used 900m");
  // The dashed lines: requests, limits and allocatable.
  await expect(cpu.getByTestId("ref-request")).toHaveText("request 1.2");
  await expect(cpu.getByTestId("ref-limit")).toHaveText("limit 2.5");
  await expect(cpu.getByTestId("ref-allocatable")).toHaveCount(0);

  // The next usage poll adds a sample.
  await page.clock.fastForward(30_000);
  const c = (await page.evaluate(() => window.__fake.cluster.overview.capacity))!;
  await fake.emitOverview({ capacity: { ...c, cpu_usage_millicores: 1100 } });
  await expect(cpu.locator('polyline[data-series="used"]')).toHaveAttribute("points", /^\S+ \S+$/);
  await expect(cpu).toContainText("used 1.1");
  expect(await fake.calls("cmdOverviewUsage")).toHaveLength(1);
  expect(fake.errors).toEqual([]);
});

test("with a Prometheus, the chart shows its last hour", async ({ page }) => {
  const fake = await openApp(page, (_cluster, f) => f.installPrometheus());
  await expect(usage(page).getByTestId("overview-usage-source")).toHaveText(
    "Last hour, from Prometheus (monitoring/prometheus-k8s:web).",
  );
  for (const r of ["cpu", "memory"]) {
    const points = await usage(page).getByTestId(`usage-chart-${r}`).locator("polyline").getAttribute("points");
    expect(points?.split(" ")).toHaveLength(120);
  }
  await expect(usage(page).getByTestId("usage-chart-memory").getByTestId("ref-limits set")).toHaveText("limits set 6Gi");
  expect(fake.errors).toEqual([]);
});

test("when Prometheus fails, the chart says why and falls back", async ({ page }) => {
  await openApp(page, (cluster, f) => {
    f.installPrometheus();
    cluster.prometheus.failure = "Prometheus at monitoring/prometheus-k8s:web is not available.";
  });
  await expect(usage(page).getByTestId("overview-usage-note")).toHaveText(
    "Prometheus at monitoring/prometheus-k8s:web is not available. Showing the metrics-server samples instead.",
  );
  await expect(usage(page).getByTestId("overview-usage-source")).toHaveText(/^Sampled from metrics-server/);
});

test("without metrics-server or Prometheus there is no chart", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.overview.capacity!.metrics = false;
  });
  await expect(capacity(page)).toContainText("No usage: the metrics API (metrics-server) is not available.");
  await expect(usage(page)).toHaveCount(0);
  // The limits do not need metrics.
  await expect(capacity(page)).toContainText("2.5 limits (31%)");
});

test("hidden metrics: no chart and nothing asked", async ({ page }) => {
  const fake = await openApp(page, hideDev);
  await expect(capacity(page)).toContainText("2.5 limits (31%)");
  await expect(capacity(page).getByTestId("metrics-hidden")).toBeVisible();
  await expect(usage(page)).toHaveCount(0);
  expect(await fake.calls("cmdOverviewUsage")).toEqual([]);
});
