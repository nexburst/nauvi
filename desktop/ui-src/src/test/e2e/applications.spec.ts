import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, toggleNamespaces } from "./helpers";

// Applications (#226): workloads grouped by app labels and Helm release
// (fixtures/applications.ts), live from a feed, with a side panel that
// opens each workload and the Helm release.

const view = (page: Page) => page.getByTestId("applications");
const appRows = (page: Page) => view(page).getByTestId("application-row");
const appRow = (page: Page, key: string) => view(page).locator(`[data-testid="application-row"][data-key="${key}"]`);
const panel = (page: Page) => page.getByTestId("application-detail");

async function openApplications(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Applications", exact: true }).click();
  await expect(view(page)).toBeVisible();
}

test("applications are listed with their rolled-up status, filtered and sorted", async ({ page }) => {
  const fake = await openApp(page);
  await openApplications(page);
  await expect(page.locator("header")).toContainText("Live");
  await expect(appRows(page)).toHaveCount(4);
  await expect(appRows(page).locator(".name")).toHaveText(["coredns", "migrate", "shop", "web"]);
  await expect(appRow(page, "demo/shop")).toContainText("Progressing");
  await expect(appRow(page, "demo/shop")).toContainText("1 Deployment, 1 CronJob");
  await expect(appRow(page, "demo/shop")).toContainText("api, nightly");
  await expect(appRow(page, "demo/shop")).toContainText("1.4.0");
  await expect(appRow(page, "demo/web")).toContainText("Helm release");
  await expect(appRow(page, "demo/migrate")).toContainText("Degraded");
  await expect(page.locator("footer")).toContainText("4 of 4 applications");

  // Status sort: worst first.
  await view(page).getByRole("button", { name: "Sort by Status" }).click();
  // Ties by namespace/name.
  await expect(appRows(page).locator(".name")).toHaveText(["migrate", "shop", "web", "coredns"]);

  // The filter searches workload names too.
  await page.getByLabel("Filter").fill("nightly");
  await expect(appRows(page)).toHaveCount(1);
  await page.getByLabel("Filter").fill("nothing-like-this");
  await expect(view(page).getByTestId("applications-empty")).toContainText("No applications match the filter.");
  await page.getByLabel("Filter").fill("");

  // The namespace selection starts a new feed for it.
  await toggleNamespaces(page, "demo");
  await expect(appRows(page)).toHaveCount(3);
  const starts = await fake.calls("cmdApplicationsStart");
  expect(starts.at(-1)?.namespaces).toEqual(["demo"]);
  expect((await fake.calls("cmdApplicationsStop")).length).toBeGreaterThan(0);
  expect(fake.errors).toEqual([]);
});

test("a row opens its workloads and Helm release", async ({ page }) => {
  await openApp(page);
  await openApplications(page);
  await appRow(page, "demo/shop").click();
  await expect(panel(page)).toContainText("Application demo/shop");
  await expect(panel(page)).toContainText("Deployment api: 1 of 3 ready");
  await expect(panel(page)).toContainText("instance label");
  await expect(panel(page)).toContainText("kustomize");
  const workloads = panel(page).getByTestId("application-workload");
  await expect(workloads).toHaveCount(2);
  await expect(panel(page).getByRole("button", { name: "Open Helm release" })).toHaveCount(0);

  // Escape closes the panel.
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);

  // A workload opens in its table, with its detail.
  await appRow(page, "demo/shop").click();
  await workloads.first().click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  await expect(page.getByTestId("detail-panel")).toContainText("api");

  // A Helm application opens its release.
  await openApplications(page);
  await appRow(page, "demo/web").click();
  await panel(page).getByRole("button", { name: "Open Helm release" }).click();
  await expect(page.getByTestId("helm-detail")).toContainText("demo/web");
});

test("the panel follows the live list and closes when the application is gone", async ({ page }) => {
  const fake = await openApp(page);
  await openApplications(page);
  await appRow(page, "demo/shop").click();
  await expect(panel(page)).toBeVisible();
  await fake.setCluster((c) => {
    const shop = c.applications.find((a) => a.name === "shop")!;
    shop.health = "Healthy";
    shop.reason = "";
  }, null);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(appRow(page, "demo/shop")).toContainText("Healthy");
  await expect(panel(page)).toContainText("Healthy");
  await fake.setCluster((c) => {
    c.applications = c.applications.filter((a) => a.name !== "shop");
  }, null);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(appRows(page)).toHaveCount(3);
  await expect(panel(page)).toHaveCount(0);
});

test("without labelled workloads the view explains what it groups", async ({ page }) => {
  await openApp(page, (c) => {
    c.applications = [];
  });
  await openApplications(page);
  await expect(view(page).getByTestId("applications-empty")).toContainText("No applications found.");
  await expect(view(page).getByTestId("applications-empty")).toContainText("app.kubernetes.io/instance");
});

test("a namespace-scoped user sees the applications of its namespace, with notes", async ({ page }) => {
  await openApp(page, (c) => {
    c.defaultNamespace = "demo";
    c.deniedClusterWide = ["apps/v1/deployments", "apps/v1/statefulsets", "apps/v1/daemonsets", "batch/v1/cronjobs", "batch/v1/jobs"];
  });
  await openApplications(page);
  // It starts in its namespace: no notes.
  await expect(appRows(page)).toHaveCount(3);
  await expect(view(page).getByTestId("applications-notes")).toHaveCount(0);
  // All namespaces: narrowed to its own, with a note per kind.
  await toggleNamespaces(page, "demo");
  await expect(view(page).getByTestId("applications-notes")).toContainText(
    "Deployments: showing namespace demo only (not allowed across all namespaces)",
  );
  await expect(appRows(page)).toHaveCount(3);
});
