import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

// "Hide metrics" per cluster (#327): no metric columns, usage charts or
// overview usage, a note where they would be, and no metrics polling.

const headers = async (page: Page) =>
  (await page.locator(".table .head .th").allTextContents()).map((h) =>
    h.replace(/[▲▼]/g, "").trim(),
  );
const note = (page: Page) => page.getByTestId("metrics-hidden");
const clusterDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Cluster settings" });

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
    mode: "normal",
  };
};
const hideProd = (cluster: FakeCluster) => {
  cluster.settings.contexts["prod"] = {
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
    mode: "normal",
  };
};

test("hidden metrics: no CPU or memory columns, a note, and no polling", async ({
  page,
}) => {
  const fake = await openApp(page, hideDev);
  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();
  const cols = await headers(page);
  expect(cols).not.toContain("CPU");
  expect(cols).not.toContain("Memory");
  await expect(note(page)).toHaveText(/Metrics hidden for this cluster/);

  await openKind(page, "Nodes");
  await expect(row(page, "node-1")).toBeVisible();
  expect(await headers(page)).not.toContain("CPU");
  await expect(note(page)).toBeVisible();

  // Other kinds have no metrics, so no note.
  await openKind(page, "Services");
  await expect(note(page)).toHaveCount(0);

  expect(await fake.calls("cmdGetMetrics")).toEqual([]);
  expect(await fake.calls("cmdNodeDiskUsage")).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("hidden metrics: the pod panel shows the note instead of usage charts", async ({
  page,
}) => {
  const fake = await openApp(page, hideDev);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  const charts = page.getByTestId("detail-panel").getByTestId("usage-charts");
  await expect(charts.getByTestId("metrics-hidden")).toBeVisible();
  await expect(charts.getByTestId("usage-chart-cpu")).toHaveCount(0);
  expect(await fake.calls("cmdUsageHistory")).toEqual([]);
});

test("hidden metrics: the overview shows requests but no usage", async ({
  page,
}) => {
  await openApp(page, hideDev);
  const capacity = page.getByRole("region", { name: "Capacity" });
  await expect(capacity).toContainText("1.2 / 8 requested (15%)");
  await expect(capacity).not.toContainText("used (");
  await expect(capacity.getByTestId("metrics-hidden")).toBeVisible();
});

test("only the cluster it is set for hides metrics", async ({ page }) => {
  const fake = await openApp(page, hideProd);
  await openKind(page, "Pods");
  expect(await headers(page)).toContain("CPU");
  await expect(note(page)).toHaveCount(0);
  await expect
    .poll(async () => (await fake.calls("cmdGetMetrics")).length)
    .toBeGreaterThan(0);
});

test("the cluster settings toggle hides and shows metrics at once", async ({
  page,
}) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect.poll(async () => await headers(page)).toContain("CPU");
  await expect
    .poll(async () => (await fake.calls("cmdGetMetrics")).length)
    .toBeGreaterThan(0);

  // The palette opens this cluster's settings.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("cluster settings");
  await page.keyboard.press("Enter");
  const hide = clusterDialog(page).getByRole("checkbox", {
    name: "Hide metrics",
  });
  await expect(hide).not.toBeChecked();
  await hide.check();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__fake.cluster.settings.contexts["kind-dev"]?.hide_metrics,
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");

  expect(await headers(page)).not.toContain("CPU");
  const polled = (await fake.calls("cmdGetMetrics")).length;

  // The note's link opens the settings again; showing metrics polls again.
  await note(page).getByRole("button", { name: "Settings" }).click();
  await expect(clusterDialog(page)).toBeVisible();
  await clusterDialog(page)
    .getByRole("checkbox", { name: "Hide metrics" })
    .uncheck();
  await page.keyboard.press("Escape");
  await expect.poll(async () => await headers(page)).toContain("CPU");
  await expect(note(page)).toHaveCount(0);
  await expect
    .poll(async () => (await fake.calls("cmdGetMetrics")).length)
    .toBeGreaterThan(polled);
  expect(fake.errors).toEqual([]);
});
