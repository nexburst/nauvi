// The sidebar (#481): icons, common kinds first with the rest under "More",
// a filter, pins, the rail of icons it collapses to; and the layout of a
// first launch (#490).

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

const kinds = (page: Page) => page.getByTestId("sidebar-kinds");
const kind = (page: Page, name: string) => kinds(page).getByRole("button", { name, exact: true });
const group = (page: Page, id: string) => kinds(page).locator(`[data-group="${id}"]`);
const more = (page: Page, id: string) => kinds(page).locator(`[data-testid="sidebar-more"][data-section="${id}"]`);
const filter = (page: Page) => page.getByTestId("sidebar-filter");

test("each kind has an icon; the common kinds come first and the rest wait under More", async ({ page }) => {
  const fake = await openApp(page);
  // An icon per kind and per view of its own.
  await expect(kind(page, "Pods").locator("svg[data-icon='pod']")).toBeVisible();
  await expect(kind(page, "Deployments").locator("svg[data-icon='deployment']")).toBeVisible();
  await expect(kind(page, "Releases").locator("svg[data-icon='helm']")).toBeVisible();

  // Workloads: the common kinds in their order, ReplicaSets under More.
  const labels = group(page, "workloads").locator("button.kind .label");
  await expect(labels).toHaveText(["Overview", "Applications", "Pods", "Deployments", "StatefulSets", "DaemonSets", "Jobs", "CronJobs"]);
  await expect(kind(page, "ReplicaSets")).toHaveCount(0);
  await expect(more(page, "workloads")).toHaveText("1 more");

  await more(page, "workloads").click();
  await expect(kind(page, "ReplicaSets")).toBeVisible();
  await expect(more(page, "workloads")).toHaveText("Fewer");
  expect((await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ open_more_sections: ["workloads"] });

  // Remembered after a restart.
  await page.reload();
  await expect(kind(page, "ReplicaSets")).toBeVisible();

  // The open kind stays in sight when its More is closed again.
  await openKind(page, "ReplicaSets");
  await more(page, "workloads").click();
  await expect(kind(page, "ReplicaSets")).toHaveClass(/active/);
  await expect(more(page, "workloads")).toHaveText("1 more");
  await openKind(page, "Pods");
  await expect(kind(page, "ReplicaSets")).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("Helm comes before Access Control, after Cluster", async ({ page }) => {
  await openApp(page);
  const order = await kinds(page).locator("[data-group]").evaluateAll((els) => els.map((e) => e.getAttribute("data-group")));
  expect(order.indexOf("helm")).toBe(order.indexOf("cluster") + 1);
  expect(order.indexOf("helm")).toBeLessThan(order.indexOf("access"));
});

test("the filter keeps what matches, drops empty sections, and opens the first match on Enter", async ({ page }) => {
  await openApp(page);
  await filter(page).fill("helm");
  await expect(kind(page, "Releases")).toBeVisible();
  await expect(kind(page, "Charts")).toBeVisible();
  // No empty section heads (the "Network" head over Helm, #481).
  await expect(kinds(page).locator("[data-group]")).toHaveCount(1);
  await expect(kinds(page).locator("h4")).toHaveText(["Helm"]);

  // Kinds under More are found too, and by kubectl's short names.
  await filter(page).fill("rs");
  await expect(kind(page, "ReplicaSets")).toBeVisible();
  await filter(page).fill("ingress");
  await expect(kind(page, "Ingresses")).toBeVisible();
  await expect(kind(page, "Ingress Classes")).toBeVisible();
  await expect(kinds(page).getByTestId("sidebar-more")).toHaveCount(0);

  // A section's name keeps the whole section.
  await filter(page).fill("storage");
  await expect(kinds(page).locator("[data-group]")).toHaveCount(1);
  await expect(kinds(page).locator("h4")).toHaveText(["Storage"]);

  // Nothing: said so.
  await filter(page).fill("zzzz");
  await expect(page.getByTestId("sidebar-no-match")).toHaveText("No kind matches “zzzz”.");

  // Enter opens the first match; the filter stays until it is cleared.
  await filter(page).fill("secr");
  await filter(page).press("Enter");
  await expect(page.getByTestId("resource-table")).toBeVisible();
  await expect(kind(page, "Secrets")).toHaveClass(/active/);
  await expect(filter(page)).toHaveValue("secr");
  await filter(page).press("Escape");
  await expect(filter(page)).toHaveValue("");
  await expect(kind(page, "Pods")).toBeVisible();
});

test("G goes to the filter while the kinds are a column", async ({ page }) => {
  await openApp(page);
  await page.locator("body").click({ position: { x: 700, y: 400 } });
  await page.keyboard.press("g");
  await expect(filter(page)).toBeFocused();
  await page.keyboard.type("cm");
  await page.keyboard.press("Enter");
  await expect(kind(page, "Config Maps")).toHaveClass(/active/);
});

test("kinds are pinned to the top from their menu, open with their key, and unpinned", async ({ page }) => {
  await openApp(page);
  const pinned = page.getByTestId("sidebar-pinned");
  // A new install keeps Pods, Deployments and Services at hand.
  await expect(pinned.locator("button.kind .label")).toHaveText(["Pods", "Deployments", "Services"]);

  await kind(page, "Config Maps").click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await menu.getByRole("menuitem", { name: "Pin to top" }).click();
  await expect(pinned.getByRole("button", { name: "Config Maps (pinned)" })).toBeVisible();
  // Still in its own section too.
  await expect(kind(page, "Config Maps")).toBeVisible();

  // Its key: 1 is the Overview, then the pins in order.
  await page.locator("body").click({ position: { x: 700, y: 400 } });
  await page.keyboard.press("5");
  await expect(kind(page, "Config Maps")).toHaveClass(/active/);

  // Remembered, and unpinned from either place.
  await page.reload();
  await expect(pinned.getByRole("button", { name: "Config Maps (pinned)" })).toBeVisible();
  await pinned.getByRole("button", { name: "Config Maps (pinned)" }).click({ button: "right" });
  await page.getByTestId("context-menu").getByRole("menuitem", { name: "Unpin" }).click();
  await expect(pinned.getByRole("button", { name: "Config Maps (pinned)" })).toHaveCount(0);
});

test("collapsed, the sidebar is a rail of icons with tooltips; expanded again, the column", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Collapse the sidebar" }).click();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  const rail = page.getByTestId("berths");
  await expect(rail.getByTestId("berth")).toHaveCount(4);
  await expect(rail.locator("svg[data-icon='dashboard']")).toBeVisible();
  await expect(rail.locator("svg[data-icon='pod']")).toBeVisible();
  await expect(rail.getByRole("button", { name: "Berth 2: Pods" })).toHaveAttribute("title", /^Pods/);
  // Where every other kind is, in words.
  await expect(page.getByTestId("chart-toggle")).toContainText("All kinds");

  await rail.getByRole("button", { name: "Berth 2: Pods" }).click();
  await expect(row(page, "crashed")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("berths")).toBeVisible();
  await page.getByTestId("sidebar-expand").click();
  await expect(kind(page, "Pods")).toBeVisible();
  await expect(page.getByTestId("berths")).toHaveCount(0);
});

test.describe("first launch (#490)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("481-started")) {
        sessionStorage.setItem("481-started", "1");
        localStorage.clear();
      }
      localStorage.setItem("nauvi.test.first-launch", "1");
    });
  });

  test("a 1280-px window starts with every kind in words, beside the sheet", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await expect(filter(page)).toBeVisible();
    await expect(kind(page, "Deployments")).toBeVisible();
    await expect(page.getByTestId("berths")).toHaveCount(0);
  });

  test("a narrow window starts with the rail, its compass labelled, and remembers the choice", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openApp(page, undefined, { waitForKinds: false });
    await expect(page.getByTestId("berths")).toBeVisible();
    await expect(page.getByTestId("chart-toggle")).toContainText("All kinds");
    await page.getByTestId("sidebar-expand").click();
    await expect(kind(page, "Pods")).toBeVisible();
    await page.reload();
    await expect(kind(page, "Pods")).toBeVisible();
  });
});
