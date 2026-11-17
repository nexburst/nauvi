import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row, rows } from "./helpers";

// Preferences (#330): the YAML editor's font and tab size, table row
// height, the time zone and start at login.

const settingsDialog = (page: Page) => page.getByTestId("settings");

async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settingsDialog(page)).toBeVisible();
}

async function closeSettings(page: Page) {
  await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(settingsDialog(page)).toHaveCount(0);
}

test("the editor font size and tab size apply to the YAML editor and are remembered", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await openSettings(page);
  const dialog = settingsDialog(page);
  await expect(dialog.getByRole("spinbutton", { name: "Editor font size" })).toHaveValue("12");
  await expect(dialog.getByRole("combobox", { name: "Editor tab size" })).toHaveValue("2");
  await dialog.getByRole("spinbutton", { name: "Editor font size" }).fill("99");
  await dialog.getByRole("spinbutton", { name: "Editor font size" }).press("Enter");
  // Kept in range.
  await expect(dialog.getByRole("spinbutton", { name: "Editor font size" })).toHaveValue("32");
  await dialog.getByRole("spinbutton", { name: "Editor font size" }).fill("16");
  await dialog.getByRole("spinbutton", { name: "Editor font size" }).press("Enter");
  await dialog.getByRole("combobox", { name: "Editor tab size" }).selectOption("4");
  await closeSettings(page);

  await row(page, "web").click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  await expect(page.locator("aside .code-editor")).toHaveAttribute("data-ready", "true");
  const editor = page.getByRole("textbox", { name: "Deployment YAML", exact: true });
  await expect(page.locator("aside .cm-editor")).toHaveCSS("font-size", "16px");
  // Tab indents the line by the tab size.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Tab");
  await expect(page.locator("aside .cm-line").first()).toHaveText(/^ {4}apiVersion/);

  // A restart keeps both.
  await page.reload();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  await openSettings(page);
  await expect(settingsDialog(page).getByRole("spinbutton", { name: "Editor font size" })).toHaveValue("16");
  await expect(settingsDialog(page).getByRole("combobox", { name: "Editor tab size" })).toHaveValue("4");
  expect(fake.errors).toEqual([]);
});

test("compact table rows are shorter and remembered", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  const height = async () => (await rows(page).first().boundingBox())?.height ?? 0;
  await expect.poll(height).toBeCloseTo(28, 0);
  await openSettings(page);
  await settingsDialog(page).getByRole("radio", { name: "Compact" }).check();
  await closeSettings(page);
  await expect.poll(height).toBeCloseTo(22, 0);
  // Every row moves up: the second starts where the first ends.
  const [a, b] = [await rows(page).nth(0).boundingBox(), await rows(page).nth(1).boundingBox()];
  expect(Math.round(b!.y - a!.y)).toBe(22);

  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await expect.poll(height).toBeCloseTo(22, 0);
  await openSettings(page);
  await settingsDialog(page).getByRole("radio", { name: "Normal" }).check();
  await closeSettings(page);
  await expect.poll(height).toBeCloseTo(28, 0);
  expect(fake.errors).toEqual([]);
});

test("times show in UTC when chosen", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(page.locator("footer")).not.toContainText("UTC");
  await openSettings(page);
  const dialog = settingsDialog(page);
  await expect(dialog.getByRole("radio", { name: "Local time" })).toBeChecked();
  await dialog.getByRole("radio", { name: "UTC" }).check();
  await closeSettings(page);
  expect((await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ time_zone: "utc" });

  // The next change from the cluster stamps the footer in UTC.
  await page.evaluate(() => window.__fake.emitWatchBatch({ deleted: ["demo/web-1"] }));
  await expect(page.locator("footer")).toContainText(/Updated \d\d:\d\d:\d\d UTC/);
  // And after a restart.
  await page.reload();
  await openKind(page, "Pods");
  await page.evaluate(() => window.__fake.emitWatchBatch({ deleted: ["demo/web-2"] }));
  await expect(page.locator("footer")).toContainText(/Updated \d\d:\d\d:\d\d UTC/);
  expect(fake.errors).toEqual([]);
});

test("start at login is off by default and turns on through the backend", async ({ page }) => {
  const fake = await openApp(page);
  await openSettings(page);
  const box = settingsDialog(page).getByRole("checkbox", { name: "Start at login" });
  await expect(box).not.toBeChecked();
  await expect(box).toBeEnabled();
  await box.check();
  await expect(box).toBeChecked();
  expect(await fake.lastCall("cmdAutostartSet")).toEqual({ enabled: true });
  await closeSettings(page);

  // Read again from the OS when Settings opens.
  await openSettings(page);
  await expect(settingsDialog(page).getByRole("checkbox", { name: "Start at login" })).toBeChecked();

  // A refusal is shown, and the box shows what the OS has.
  await fake.failNext("cmdAutostartSet", "Could not turn off start at login: Permission denied");
  // (A click: the box goes back to on, which `uncheck()` would reject.)
  await settingsDialog(page).getByRole("checkbox", { name: "Start at login" }).click();
  await expect(settingsDialog(page).getByTestId("autostart-error")).toHaveText(
    "Could not turn off start at login: Permission denied",
  );
  await expect(settingsDialog(page).getByRole("checkbox", { name: "Start at login" })).toBeChecked();
  expect(fake.errors).toEqual([]);
});
