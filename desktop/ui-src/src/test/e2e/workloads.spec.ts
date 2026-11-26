import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, row, rows, toggleNamespaces } from "./helpers";

// Workloads → Overview (#79): live status counts per kind from the fake
// cluster's rows (fixtures/workloads.ts), clickable to filtered tables, and
// the aggregated usage charts of workload panels.

const view = (page: Page) => page.getByTestId("workloads-overview");
const card = (page: Page, kind: string) => view(page).locator(`.card[data-kind="${kind}"]`);
const count = (page: Page, kind: string, status: string) =>
  card(page, kind).locator(`button[data-status="${status}"] .count`);

async function openWorkloads(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Workloads overview" }).click();
  await expect(view(page).locator(".card").first()).toBeVisible();
}

test("the workloads overview counts every kind by status", async ({ page }) => {
  const fake = await openApp(page);
  await openWorkloads(page);
  await expect(page.locator("header")).toContainText("Live");
  // Pods: web-1, web-2, coredns-1 running; db-0 pending; crashed errors.
  await expect(card(page, "Pod").locator(".total")).toHaveText("5");
  await expect(count(page, "Pod", "Running")).toHaveText("3");
  await expect(count(page, "Pod", "Pending")).toHaveText("1");
  await expect(count(page, "Pod", "Error")).toHaveText("1");
  await expect(card(page, "Pod")).toHaveClass(/alert/);
  // Deployments: web 2/2, api 1/3.
  await expect(count(page, "Deployment", "Running")).toHaveText("1");
  await expect(count(page, "Deployment", "Pending")).toHaveText("1");
  await expect(count(page, "Job", "Failed")).toHaveText("1");
  await expect(count(page, "Job", "Succeeded")).toHaveText("1");
  await expect(count(page, "CronJob", "Suspended")).toHaveText("1");
  // Every workload kind, in sidebar order.
  await expect(view(page).locator(".card .name")).toHaveText([
    "Pods",
    "Deployments",
    "DaemonSets",
    "StatefulSets",
    "ReplicaSets",
    "Jobs",
    "CronJobs",
  ]);
  // A zero count opens nothing.
  await expect(card(page, "StatefulSet").locator('button[data-status="Running"]')).toBeDisabled();

  const problems = view(page).getByRole("region", { name: "Problem workloads" });
  await expect(problems.locator(".problem")).toHaveCount(3);
  await expect(problems.locator(".problem").first()).toContainText("demo/migrate");
  await expect(problems).toContainText("1 of 3 ready");
  await expect(problems).toContainText("Suspended");
  const warnings = view(page).getByRole("region", { name: "Workload warnings" });
  // The Deployment's warning, not the one about an unknown kind.
  await expect(warnings.locator(".event")).toHaveCount(1);
  await expect(warnings).toContainText("FailedCreate");

  expect(await fake.workloadsFeeds()).toEqual([{ id: expect.any(Number), namespaces: [] }]);
});

test("counts update live, pushed by the backend", async ({ page }) => {
  const fake = await openApp(page);
  await openWorkloads(page);
  await expect(count(page, "Deployment", "Running")).toHaveText("1");
  // api becomes ready.
  await fake.setCluster((cluster) => {
    const api = cluster.rows["apps/v1/deployments"].find((r) => r.name === "api")!;
    api.status = "Running";
  }, null);
  await fake.emitWorkloads();
  await expect(count(page, "Deployment", "Running")).toHaveText("2");
  await expect(count(page, "Deployment", "Pending")).toHaveText("0");
  expect(await fake.calls("cmdWorkloadsStart")).toHaveLength(1);
});

test("the overview follows the namespace selection, one feed at a time", async ({ page }) => {
  const fake = await openApp(page);
  await openWorkloads(page);
  await expect(card(page, "Pod").locator(".total")).toHaveText("5");
  await toggleNamespaces(page, "kube-system");
  await expect(card(page, "Pod").locator(".total")).toHaveText("1");
  await expect(card(page, "Deployment").locator(".total")).toHaveText("0");
  await expect(view(page)).toContainText("Workloads in namespace kube-system");
  expect((await fake.lastCall("cmdWorkloadsStart")).namespaces).toEqual(["kube-system"]);
  // The previous feed was stopped.
  const feeds = await fake.workloadsFeeds();
  expect(feeds).toHaveLength(1);
  expect(feeds[0].namespaces).toEqual(["kube-system"]);

  // Leaving the view stops its feed.
  await openKind(page, "Pods");
  await expect.poll(() => fake.workloadsFeeds()).toEqual([]);
});

test("each feed has its own channel: a stopped feed's messages are ignored (#115)", async ({ page }) => {
  const fake = await openWorkloads2(page);
  const [first] = await fake.workloadsFeeds();
  expect((await fake.lastCall("cmdWorkloadsStart")).onEvent).toBeDefined();
  await toggleNamespaces(page, "kube-system");
  await expect(card(page, "Pod").locator(".total")).toHaveText("1");
  // The old feed (all namespaces: 5 pods) still sends: nothing changes.
  await fake.emitWorkloads(first.id);
  await fake.emitFeedState("workloads", { id: first.id, state: "reconnecting", error: "old feed" });
  await expect(card(page, "Pod").locator(".total")).toHaveText("1");
  await expect(page.locator("header")).toContainText("Live");
  // The running feed's state does show.
  await fake.emitFeedState("workloads", { state: "reconnecting", error: "Lost the connection to the cluster; retrying." });
  await expect(page.locator("header")).toContainText("Reconnecting");
  await fake.emitFeedState("workloads", { state: "live" });
  await expect(page.locator("header")).toContainText("Live");
});

async function openWorkloads2(page: Page) {
  const fake = await openApp(page);
  await openWorkloads(page);
  await expect(card(page, "Pod").locator(".total")).toHaveText("5");
  return fake;
}

test("a status count opens the kind's table filtered by that status", async ({ page }) => {
  await openApp(page);
  await openWorkloads(page);
  await card(page, "Pod").locator('button[data-status="Running"]').click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toHaveClass(/active/);
  await expect(page.getByTestId("status-filter")).toContainText("Status: Running");
  await expect(rows(page)).toHaveCount(3);
  expect(await column(page, "Name")).toEqual(["web-1", "web-2", "coredns-1"]);

  // Clearing the filter shows every pod.
  await page.getByRole("button", { name: "Show every status" }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByTestId("status-filter")).toHaveCount(0);

  // Another view drops the filter too.
  await openWorkloads(page);
  await card(page, "Deployment").locator('button[data-status="Pending"]').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "api")).toBeVisible();
  await openKind(page, "Deployments");
  await expect(page.getByTestId("status-filter")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
});

test("a problem workload opens its detail panel", async ({ page }) => {
  await openApp(page);
  await openWorkloads(page);
  await view(page).getByRole("button", { name: "demo/api" }).click();
  await expect(page.getByTestId("detail-panel")).toContainText("Deployment demo/api");
});

test("a workload panel charts its pods' summed usage, from both sources", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click();
  const charts = page.getByTestId("detail-panel").getByTestId("usage-charts");
  // No Prometheus: the metrics-server history, with why.
  await expect(charts.getByTestId("usage-since")).toHaveText(/^Collecting since/);
  await expect(charts.getByTestId("usage-note")).toContainText("No Prometheus Service found");
  const cpu = charts.getByTestId("usage-chart-cpu");
  await expect(cpu.locator('polyline[data-series="pods"]')).toHaveCount(1);
  await expect(cpu.getByTestId("ref-request")).toHaveText("request 200m");
  const mem = charts.getByTestId("usage-chart-memory");
  await expect(mem.getByTestId("ref-limit")).toHaveText("limit 256 MiB");
  expect(await fake.lastCall("cmdWorkloadUsageHistory")).toEqual({
    kind: "Deployment",
    namespace: "demo",
    name: "web",
    range: "1h",
  });
});

test("with Prometheus, a workload panel charts its 1h range", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => window.__fake.installPrometheus());
  await openKind(page, "Deployments");
  await row(page, "web").click();
  const charts = page.getByTestId("detail-panel").getByTestId("usage-charts");
  await expect(charts.getByTestId("usage-source")).toHaveText(
    "From Prometheus (monitoring/prometheus-k8s:web), last 1h.",
  );
  await expect(charts.getByRole("button", { name: "24h" })).toBeVisible();
  // A workload without Prometheus series falls back to the live history.
  await page.getByTestId("detail-panel").getByRole("button", { name: "Close details" }).click();
  await row(page, "api").click();
  await expect(page.getByTestId("detail-panel").getByTestId("usage-note")).toContainText(
    "no CPU and memory samples for the pods of this Deployment in the last 1h",
  );
});
