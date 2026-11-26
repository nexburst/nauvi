import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// Usage history from Prometheus (#47 phase 2): 1h/6h/24h ranges in the pod
// and node charts, the fallback to metrics-server with the reason, and the
// per-context Prometheus setting.

const charts = (page: Page) => page.getByTestId("detail-panel").getByTestId("usage-charts");
const rangeButton = (page: Page, label: string) =>
  charts(page).getByRole("group", { name: "Usage range" }).getByRole("button", { name: label, exact: true });

const savedSetting = (page: Page) =>
  page.evaluate(() => window.__fake.cluster.settings.contexts["kind-dev"]?.prometheus ?? "");

async function openPod(page: Page, name = "web-1") {
  await openKind(page, "Pods");
  await row(page, name).click();
}

test("with a Prometheus, the pod charts show the last hour from it", async ({ page }) => {
  const fake = await openApp(page, (_cluster, f) => f.installPrometheus());
  await openPod(page);
  await expect(charts(page).getByTestId("usage-source")).toHaveText(
    "From Prometheus (monitoring/prometheus-k8s:web), last 1h.",
  );
  await expect(rangeButton(page, "1h")).toHaveAttribute("aria-pressed", "true");
  const cpu = charts(page).getByTestId("usage-chart-cpu");
  // 120 points per line, the pod and each container.
  for (const series of ["pod", "app", "sidecar"]) {
    expect((await cpu.locator(`polyline[data-series="${series}"]`).getAttribute("points"))?.split(" ")).toHaveLength(
      120,
    );
  }
  // The reference lines come from the pod spec as before.
  await expect(cpu.getByTestId("ref-request")).toHaveText("request 100m");
  await expect(charts(page).getByTestId("usage-note")).toHaveCount(0);

  // Live is the metrics-server history.
  await rangeButton(page, "Live").click();
  await expect(charts(page).getByTestId("usage-since")).toHaveText(/^Collecting since \d\d:\d\d\./);
  await expect(rangeButton(page, "Live")).toHaveAttribute("aria-pressed", "true");
  expect((await cpu.locator('polyline[data-series="pod"]').getAttribute("points"))?.split(" ")).toHaveLength(12);
  const ranges = (await fake.calls("cmdUsageHistory")).map((c) => c.range);
  expect(ranges).toEqual(["1h", "live"]);
  expect(fake.errors).toEqual([]);
});

test("a range Prometheus has no data for falls back and says so", async ({ page }) => {
  await openApp(page, (_cluster, f) => f.installPrometheus());
  await openPod(page);
  await rangeButton(page, "6h").click();
  await expect(charts(page).getByTestId("usage-note")).toHaveText(
    "Prometheus at monitoring/prometheus-k8s:web has no CPU and memory samples for this pod in the last 6h. " +
      "Showing the metrics-server history instead.",
  );
  await expect(charts(page).getByTestId("usage-since")).toBeVisible();
  // The choice stays, so the buttons still say what was asked for.
  await expect(rangeButton(page, "6h")).toHaveAttribute("aria-pressed", "true");
});

test("a denied service proxy shows why, over the metrics-server history", async ({ page }) => {
  await openApp(page, (cluster, f) => {
    f.installPrometheus();
    cluster.prometheus.failure =
      "Not allowed to reach Prometheus at monitoring/prometheus-k8s:web through the API server's service proxy " +
      "(needs get on services/proxy in monitoring).";
  });
  await openPod(page);
  await expect(charts(page).getByTestId("usage-note")).toContainText("needs get on services/proxy in monitoring");
  await expect(charts(page).getByTestId("usage-note")).toContainText("Showing the metrics-server history instead.");
  await expect(charts(page).getByTestId("usage-since")).toBeVisible();
  await expect(charts(page).getByTestId("usage-chart-cpu")).toBeVisible();
});

test("without a Prometheus there are no ranges, and the panel says it looked", async ({ page }) => {
  await openApp(page);
  await openPod(page);
  await expect(charts(page).getByTestId("usage-note")).toContainText("No Prometheus Service found");
  await expect(charts(page).getByRole("group", { name: "Usage range" })).toHaveCount(0);
  await expect(charts(page).getByTestId("usage-since")).toBeVisible();
});

test("the node charts come from Prometheus too", async ({ page }) => {
  await openApp(page, (_cluster, f) => f.installPrometheus());
  await openKind(page, "Nodes");
  await row(page, "node-1").click();
  await expect(charts(page).getByTestId("usage-source")).toHaveText(
    "From Prometheus (monitoring/prometheus-k8s:web), last 1h.",
  );
  const mem = charts(page).getByTestId("usage-chart-memory");
  await expect(mem.getByTestId("ref-allocatable")).toHaveText("allocatable 7 GiB");
  expect((await mem.locator('polyline[data-series="node"]').getAttribute("points"))?.split(" ")).toHaveLength(120);
});

test("the Prometheus Service is set per context in Settings", async ({ page }) => {
  const fake = await openApp(page, (_cluster, f) => f.installPrometheus());
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.getByRole("dialog", { name: "Settings" }).getByTestId("prometheus-settings");
  const input = section.getByRole("textbox", { name: "Prometheus Service" });
  const status = section.getByTestId("prometheus-status");
  await expect(status).toHaveText("Using monitoring/prometheus-k8s:web (detected).");
  await expect(section).toContainText("Service for kind-dev");

  // A malformed value is not saved.
  await input.fill("prometheus");
  await input.press("Enter");
  await expect(section.getByTestId("prometheus-error")).toContainText("Use namespace/service:port");
  expect(await savedSetting(page)).toBe("");

  await input.fill("obs/prom:9090");
  await input.press("Enter");
  await expect(section.getByTestId("prometheus-error")).toHaveCount(0);
  await expect(status).toHaveText("Using obs/prom:9090 (from Settings).");
  await expect.poll(() => savedSetting(page)).toBe("obs/prom:9090");

  await input.fill("off");
  await input.press("Enter");
  await expect(status).toHaveText("Prometheus is turned off for this context in Settings.");

  await section.getByRole("button", { name: "Detect again" }).click();
  await expect.poll(async () => (await fake.calls("cmdPrometheusStatus")).at(-1)).toEqual({ redetect: true });
  expect(fake.errors).toEqual([]);
});
