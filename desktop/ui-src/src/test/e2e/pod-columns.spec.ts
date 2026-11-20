import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, row } from "./helpers";

// Off-by-default Pod columns (#378): Controlled By, QoS, IP, Nominated Node.

const header = (page: Page, label: string) => page.getByRole("columnheader", { name: label, exact: true });
const chooser = (page: Page) => page.getByRole("dialog", { name: "Columns" });
const EXTRA = ["Controlled By", "QoS", "IP", "Nominated Node"];

async function restart(page: Page) {
  await page.reload();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
}

test("the extra pod columns are off by default and listed unchecked", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(header(page, "Status")).toBeVisible();
  for (const label of EXTRA) await expect(header(page, label)).toHaveCount(0);

  // Off is not "hidden": the button counts none.
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(chooser(page).getByText("More columns")).toBeVisible();
  for (const label of EXTRA) {
    await expect(chooser(page).getByRole("checkbox", { name: label, exact: true })).not.toBeChecked();
  }
  await expect(chooser(page).getByRole("checkbox", { name: "Node", exact: true })).toBeChecked();
  await expect(chooser(page).getByRole("button", { name: "Default columns" })).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("turning the extra columns on shows them, and the choice survives a restart", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  for (const label of ["Controlled By", "QoS", "IP"]) {
    await chooser(page).getByRole("checkbox", { name: label, exact: true }).check();
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Columns", exact: true })).toBeVisible();
  await expect(header(page, "Controlled By")).toBeVisible();
  await expect(header(page, "Nominated Node")).toHaveCount(0);
  expect(await column(page, "QoS")).toContain("Burstable");
  expect(await column(page, "IP")).toContain("10.244.0.5");
  await expect(row(page, "web-1").getByTestId("owner-link")).toHaveText("ReplicaSet/web-5d8f");
  // A pod without an owner has an empty cell, not a link.
  await expect(row(page, "crashed").getByTestId("owner-link")).toHaveCount(0);

  await restart(page);
  await expect(header(page, "Controlled By")).toBeVisible();
  await expect(header(page, "QoS")).toBeVisible();
  await expect(header(page, "IP")).toBeVisible();

  // Default columns: back to what a fresh install shows.
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await chooser(page).getByRole("checkbox", { name: "Node", exact: true }).uncheck();
  await chooser(page).getByRole("button", { name: "Default columns" }).click();
  await expect(header(page, "Node")).toBeVisible();
  for (const label of EXTRA) await expect(header(page, label)).toHaveCount(0);
  await expect(chooser(page).getByRole("button", { name: "Default columns" })).toHaveCount(0);
});

test("the Controlled By link opens the owner's detail", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await chooser(page).getByRole("checkbox", { name: "Controlled By", exact: true }).check();
  await page.keyboard.press("Escape");

  await row(page, "web-1").getByTestId("owner-link").click();
  const nav = page.getByRole("navigation").locator("button.active");
  await expect(nav).toHaveAccessibleName("ReplicaSets");
  await expect(page.getByTestId("detail-panel")).toContainText("web-5d8f");
  await expect(row(page, "web-5d8f")).toHaveClass(/selected/);

  // Back returns to the pods, with the column still on.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(nav).toHaveAccessibleName("Pods");
  await expect(header(page, "Controlled By")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("columns that don't fit scroll sideways, the header with the rows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await openKind(page, "Pods");
  const scroller = page.locator(".table .scroller");
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  for (const label of EXTRA) await chooser(page).getByRole("checkbox", { name: label, exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(header(page, "Nominated Node")).toHaveCount(1);
  const overflow = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeGreaterThan(0);

  await scroller.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  // The last header and the last cell of a row line up, inside the table.
  await expect(async () => {
    const grid = (await page.locator(".table .grid").boundingBox())!;
    const head = (await header(page, "Nominated Node").boundingBox())!;
    // The last cell before the row's ⋮ (#382).
    const cell = (await row(page, "web-1").getByRole("gridcell").nth(-2).boundingBox())!;
    expect(Math.abs(head.x - cell.x)).toBeLessThan(1);
    expect(head.x + head.width).toBeLessThanOrEqual(grid.x + grid.width + 1);
  }).toPass();
  await expect(row(page, "web-1").getByTestId("owner-link")).toBeVisible();
});
