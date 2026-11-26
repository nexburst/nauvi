import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, rows } from "./helpers";

// Export CSV (#221): the rows and columns on screen, through the save dialog.

const exportButton = (page: Page) => page.getByRole("button", { name: "Export CSV" });
const note = (page: Page) => page.getByTestId("csv-saved");

test("exports the filtered, sorted rows and the shown columns", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(5);

  await page.getByRole("searchbox", { name: "Filter" }).fill("web");
  const name = page.getByRole("columnheader", { name: /^Name\s*[▲▼]?$/ });
  await name.click();
  await name.click(); // descending
  await page.getByRole("button", { name: "Columns" }).click();
  const chooser = page.getByRole("dialog", { name: "Columns" });
  await chooser.getByRole("checkbox", { name: "Node", exact: true }).uncheck();
  await page.keyboard.press("Escape");

  await exportButton(page).click();
  await expect.poll(() => fake.calls("cmdSaveCsv")).toHaveLength(1);
  const call = await fake.lastCall("cmdSaveCsv");
  expect(call.filename).toMatch(/^pods_kind-dev_\d{4}-\d\d-\d\dT[\d-]+Z\.csv$/);
  const lines = String(call.content).split("\r\n");
  expect(lines.at(-1)).toBe("");
  const header = lines[0].split(",");
  expect(header[0]).toBe("Name");
  expect(header).not.toContain("Node");
  expect(lines.slice(1, -1).map((l) => l.split(",")[0])).toEqual(["web-2", "web-1"]);

  await expect(note(page)).toHaveText(`Saved 2 rows to Downloads/${call.filename}`);
  // The pointer off it: under the pointer the title shows as the app's tooltip (#483).
  await page.mouse.move(0, 0);
  await expect(note(page)).toHaveAttribute("title", `/home/tester/Downloads/${call.filename}`);
});

test("a cancelled save dialog shows nothing; a failed save says why", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.saveDialogCancels = 1;
  });
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(5);
  await exportButton(page).click();
  await expect.poll(() => fake.calls("cmdSaveCsv")).toHaveLength(1);
  await expect(note(page)).toHaveCount(0);

  await fake.failNext("cmdSaveCsv", "Could not write /x/pods.csv: Permission denied");
  await exportButton(page).click();
  await expect(note(page)).toHaveText("Could not export: Could not write /x/pods.csv: Permission denied");
});

test("cells that would run as spreadsheet formulas are neutralised", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    const pod = cluster.rows["v1/pods"][0];
    // The Name cell, as a hostile label or annotation could be.
    pod.cells[0] = '=HYPERLINK("http://evil","x")';
  });
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(5);
  await exportButton(page).click();
  await expect.poll(() => fake.calls("cmdSaveCsv")).toHaveLength(1);
  const content = String((await fake.lastCall("cmdSaveCsv")).content);
  expect(content).toContain('"\'=HYPERLINK(""http://evil"",""x"")"');
  expect(content).not.toMatch(/(^|,|\r\n)=HYPERLINK/);
});

test("the Secrets export has names, types and key counts, never values", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Secrets");
  await expect(rows(page)).toHaveCount(1);
  await exportButton(page).click();
  await expect.poll(() => fake.calls("cmdSaveCsv")).toHaveLength(1);
  const content = String((await fake.lastCall("cmdSaveCsv")).content);
  const [header, first] = content.split("\r\n");
  expect(header).toBe("Name,Namespace,Type,Data,Age");
  expect(first).toMatch(/^db-creds,demo,Opaque,1,/);
  expect(content).not.toContain("hunter2");
});
