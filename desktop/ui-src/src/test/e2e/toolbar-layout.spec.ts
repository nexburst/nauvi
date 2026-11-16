import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row, rows } from "./helpers";

// The table toolbar keeps one row at 1280x800 (#289): the namespace picker,
// the filter and its toggles, Columns, the export note, Export CSV and
// + Create, with and without the detail panel open.

const toolbar = (page: Page) => page.locator(".toolbar");
const exportButton = (page: Page) => page.getByRole("button", { name: "Export CSV" });
const note = (page: Page) => page.getByTestId("csv-saved");

/** One row, and every control inside the toolbar, left of the panel. */
async function expectOneRow(page: Page) {
  const bar = (await toolbar(page).boundingBox())!;
  expect(bar.height, "the toolbar is one row").toBeLessThanOrEqual(60);
  const right = bar.x + bar.width;
  const names = ["Match case", "Regular expression", "Star this search", /^Columns/, "Export CSV", "+ Create"];
  for (const name of names) {
    const exact = typeof name === "string";
    const b = (await toolbar(page).getByRole("button", { name, exact }).boundingBox())!;
    expect(b, `${name} is shown`).not.toBeNull();
    expect(b.x + b.width, `${name} fits the toolbar`).toBeLessThanOrEqual(right);
    expect(b.y + b.height, `${name} is on the first row`).toBeLessThanOrEqual(bar.y + 60);
  }
}

async function openPods(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(5);
  return fake;
}

test("one row at 1280 px with the saved note and with an error", async ({ page }) => {
  const fake = await openPods(page);
  await expectOneRow(page);
  // Wide enough for the names, not just the icons.
  await expect(exportButton(page)).toHaveText("Export CSV");
  await expect(toolbar(page).getByRole("button", { name: "Columns" })).toHaveText("Columns");

  await exportButton(page).click();
  await expect(note(page)).toContainText("Saved 5 rows to Downloads/");
  await expectOneRow(page);

  await fake.failNext("cmdSaveCsv", `Could not write /a/very/long/folder/${"x".repeat(80)}/pods.csv: Permission denied`);
  await exportButton(page).click();
  await expect(note(page)).toContainText("Could not export:");
  await expectOneRow(page);
  // Cut with an ellipsis; the whole message is in the tooltip.
  await expect(note(page)).toHaveAttribute("title", /Permission denied$/);
});

test("one row at 1280 px with the detail panel open: Columns and Export CSV become icons", async ({ page }) => {
  const fake = await openPods(page);
  await row(page, "web-1").click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  await expectOneRow(page);
  await expect(exportButton(page).locator(".label")).toBeHidden();
  await expect(exportButton(page).locator("svg")).toBeVisible();
  await expect(exportButton(page)).toHaveAttribute("title", /CSV/);

  // A hidden column still shows its count next to the icon.
  await toolbar(page).getByRole("button", { name: "Columns" }).click();
  await page.getByRole("dialog", { name: "Columns" }).getByRole("checkbox", { name: "Node", exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await expect(toolbar(page).getByRole("button", { name: "Columns (1 hidden)" })).toBeVisible();

  await fake.failNext("cmdSaveCsv", "Could not write /x/pods.csv: Permission denied");
  await exportButton(page).click();
  await expect(note(page)).toBeVisible();
  await expectOneRow(page);
  // No room in the row: the note shows whole, under the toolbar, left of the panel.
  const n = (await note(page).boundingBox())!;
  const bar = (await toolbar(page).boundingBox())!;
  const aside = (await page.getByTestId("detail-panel").boundingBox())!;
  expect(n.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(n.x + n.width).toBeLessThanOrEqual(aside.x);
  expect(await note(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
