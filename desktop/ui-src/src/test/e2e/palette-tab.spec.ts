// Tab in the command palette completes, or moves, and never takes the
// focus out of it (#591).
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind } from "./helpers";

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const input = (page: Page) => palette(page).getByRole("combobox");
const selected = (page: Page) => palette(page).locator('[role="option"][aria-selected="true"]');
const grid = (page: Page) => page.getByRole("grid");

test(":na Tab completes to the Namespaces kind; Enter opens it", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press(":");
  await page.keyboard.type("na");
  await page.keyboard.press("Tab");
  await expect(input(page)).toHaveValue(":namespaces");
  await expect(input(page)).toBeFocused();
  await expect(selected(page)).toContainText("Namespaces");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(grid(page)).toHaveAccessibleName("Namespaces");
});

test("after Tab the arrows and Esc still work", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+k");
  await page.keyboard.type(":po");
  await page.keyboard.press("Tab");
  await expect(input(page)).toBeFocused();
  const completed = await input(page).inputValue();
  expect(completed).toBe(":pods");
  expect(await palette(page).getByRole("option").count()).toBeGreaterThan(1);
  // Already complete: Tab moves like the down arrow, Shift+Tab back.
  const first = await selected(page).textContent();
  await page.keyboard.press("Tab");
  await expect(input(page)).toHaveValue(completed);
  await expect(selected(page)).not.toHaveText(first ?? "");
  await page.keyboard.press("Shift+Tab");
  await expect(selected(page)).toHaveText(first ?? "");
  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).not.toHaveText(first ?? "");
  await page.keyboard.press("ArrowUp");
  await expect(selected(page)).toHaveText(first ?? "");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
});

test("on an action Tab moves to the next result; focus never leaves the palette", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+k");
  await page.keyboard.type(">");
  const options = palette(page).getByRole("option");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue(">");
  await expect(options.first()).toHaveAttribute("aria-selected", "false");
  for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+Tab");
  await expect(input(page)).toBeFocused();
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
});

test("a click on the palette's padding gives the focus back to its input; Esc still closes", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+k");
  await palette(page).click({ position: { x: 4, y: 4 } });
  await expect(input(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input(page)).toBeFocused();
  // Should the focus be out of it anyway, Esc still closes it.
  await page.evaluate(() =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })),
  );
  await expect(palette(page)).toHaveCount(0);
});
