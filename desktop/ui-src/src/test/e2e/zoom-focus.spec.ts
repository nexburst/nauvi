import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// Zoom, the terminal font size and keyboard focus (#207).

const grid = (page: Page) => page.getByRole("grid");
const settingsDialog = (page: Page) => page.getByTestId("settings");
const zoomCalls = async (fake: Awaited<ReturnType<typeof openApp>>) =>
  (await fake.calls("cmdSetZoom")).map((c) => c.percent);

test("Mod+=, Mod+- and Mod+0 zoom the window, and the zoom is remembered", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  // On start the remembered zoom (100%) is set.
  await expect.poll(() => zoomCalls(fake)).toEqual([100]);

  await page.keyboard.press("ControlOrMeta+Equal");
  await page.keyboard.press("ControlOrMeta+Equal");
  await page.keyboard.press("ControlOrMeta+Minus");
  await expect.poll(() => zoomCalls(fake)).toEqual([100, 110, 125, 110]);

  // From the filter too.
  await page.keyboard.press("/");
  await expect(page.locator("#table-filter")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Equal");
  await expect.poll(() => zoomCalls(fake)).toEqual([100, 110, 125, 110, 125]);
  await expect(page.locator("#table-filter")).toHaveValue("");

  // A restart sets the remembered zoom again.
  await page.reload();
  await expect(grid(page)).toBeVisible();
  await expect.poll(() => zoomCalls(fake)).toEqual([125]);

  await page.keyboard.press("ControlOrMeta+,");
  await expect(settingsDialog(page).getByTestId("zoom-level")).toHaveText("125%");
  // Over the Settings dialog too.
  await page.keyboard.press("ControlOrMeta+0");
  await expect(settingsDialog(page).getByTestId("zoom-level")).toHaveText("100%");
  await expect(settingsDialog(page).getByRole("button", { name: "Reset", exact: true }).first()).toBeDisabled();
  await settingsDialog(page).getByRole("button", { name: "Zoom out" }).click();
  await expect(settingsDialog(page).getByTestId("zoom-level")).toHaveText("90%");
  await expect.poll(() => zoomCalls(fake)).toEqual([125, 100, 90]);
  expect(fake.errors).toEqual([]);
});

test("the terminal font size is a setting, applied to open terminals", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Shell" }).click();
  await expect.poll(() => fake.calls("cmdExecStart")).toHaveLength(1);
  const rowsEl = page.locator(".xterm-rows");
  await expect(rowsEl).toHaveCSS("font-size", "12px");

  // The terminal keeps Ctrl+, for the shell.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+,");
  const input = settingsDialog(page).getByRole("spinbutton", { name: "Terminal font size" });
  await expect(input).toHaveValue("12");
  await input.fill("16");
  await input.press("Tab");
  await expect(rowsEl).toHaveCSS("font-size", "16px");
  // Out of range: kept within 8-32.
  await input.fill("99");
  await input.press("Tab");
  await expect(input).toHaveValue("32");

  await page.reload();
  await expect(grid(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settingsDialog(page).getByRole("spinbutton", { name: "Terminal font size" })).toHaveValue("32");
});

test("clicking a row gives the table the keyboard", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await page.keyboard.press("/");
  await expect(page.locator("#table-filter")).toBeFocused();

  await row(page, "web-1").click();
  await expect(grid(page)).toBeFocused();
  // So j moves the row instead of typing into the filter.
  await page.keyboard.press("j");
  await expect(page.locator("#table-filter")).toHaveValue("");
  const id = await grid(page).getAttribute("aria-activedescendant");
  await expect(page.locator(`#${id}`)).toContainText("web-2");
});

test("the Enter that picks Shell in the row menu does not reach the shell", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Logs" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Shell" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect.poll(() => fake.calls("cmdExecStart")).toHaveLength(1);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.waitForTimeout(300);
  expect(await fake.calls("cmdExecInput")).toEqual([]);

  // Typed keys still reach it.
  await page.keyboard.type("ls");
  await expect.poll(async () => (await fake.calls("cmdExecInput")).map((c) => c.data).join("")).toBe("ls");
});
