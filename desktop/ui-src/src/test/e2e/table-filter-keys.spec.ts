// Enter, Esc and ArrowDown in the table filter go back to the rows (#590),
// as k9s's `/filter` then Enter does.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, rows } from "./helpers";

const grid = (page: Page) => page.getByRole("grid");
const filter = (page: Page) => page.getByRole("searchbox", { name: "Filter" });
const suggestions = (page: Page) => page.getByRole("listbox", { name: "Saved searches" });
const panel = (page: Page) => page.getByTestId("detail-panel");

/** The row the grid's aria-activedescendant points at. */
async function focusedRowName(page: Page): Promise<string> {
  const id = await grid(page).getAttribute("aria-activedescendant");
  expect(id, "a focused row").toBeTruthy();
  return (await page.locator(`#${id} [role="gridcell"]`).nth(1).textContent())?.trim() ?? "";
}

test("/, type, Enter: the first matching row has the focus, j and d work", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await grid(page).focus();
  await page.keyboard.press("/");
  await expect(filter(page)).toBeFocused();
  await page.keyboard.type("web");
  await page.keyboard.press("Enter");

  await expect(grid(page)).toBeFocused();
  await expect(filter(page)).toHaveValue("web");
  expect(await column(page, "Name")).toEqual(["web-1", "web-2"]);
  expect(await focusedRowName(page)).toBe("web-1");
  await page.keyboard.press("j");
  expect(await focusedRowName(page)).toBe("web-2");
  await page.keyboard.press("d");
  await expect(panel(page).locator(".title")).toContainText("web-2");
  // Enter saved the search, as before.
  expect(JSON.stringify(await fake.lastCall("cmdUpdateSettings"))).toContain('"web"');
  expect(fake.errors).toEqual([]);
});

test("Esc with the suggestions closed goes to the rows, the filter and the panel kept", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  // A saved search, so typing shows the suggestions.
  await filter(page).fill("web");
  await filter(page).press("Enter");
  await expect(grid(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeVisible();

  await page.keyboard.press("/");
  await filter(page).fill("");
  await page.keyboard.type("we");
  await expect(suggestions(page)).toBeVisible();
  // The first Esc closes the suggestions only.
  await page.keyboard.press("Escape");
  await expect(suggestions(page)).toHaveCount(0);
  await expect(filter(page)).toBeFocused();
  // The second leaves the box, without clearing it or closing the panel.
  await page.keyboard.press("Escape");
  await expect(grid(page)).toBeFocused();
  await expect(filter(page)).toHaveValue("we");
  await expect(panel(page)).toBeVisible();
  expect(await focusedRowName(page)).toBe("web-1");
  await page.keyboard.press("k");
  expect(await focusedRowName(page)).toBe("web-1");
  await page.keyboard.press("j");
  expect(await focusedRowName(page)).toBe("web-2");
});

test("ArrowDown with the suggestions closed goes to the first row; ArrowUp shows them", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await filter(page).fill("db");
  await filter(page).press("Enter");
  await expect(grid(page)).toBeFocused();

  await page.keyboard.press("/");
  await page.keyboard.press("ArrowDown");
  await expect(grid(page)).toBeFocused();
  expect(await focusedRowName(page)).toBe("db-0");

  // The saved searches are still there from the keyboard.
  await page.keyboard.press("/");
  await filter(page).fill("");
  await expect(suggestions(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(grid(page)).toBeFocused();
  await page.keyboard.press("/");
  await page.keyboard.press("ArrowUp");
  await expect(suggestions(page).getByRole("option")).toHaveText([/db/]);
  await page.keyboard.press("Enter");
  // A picked suggestion stays in the box, as before.
  await expect(filter(page)).toHaveValue("db");
  await expect(filter(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(grid(page)).toBeFocused();
  expect(await focusedRowName(page)).toBe("db-0");
});

test("no matching rows: Enter and Esc still leave the box", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await page.keyboard.press("/");
  await page.keyboard.type("nothing-matches");
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(filter(page)).not.toBeFocused();
  await expect(filter(page)).toHaveValue("nothing-matches");

  await page.keyboard.press("/");
  await expect(filter(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(filter(page)).not.toBeFocused();
  // `/` still brings it back.
  await page.keyboard.press("/");
  await expect(filter(page)).toBeFocused();
});

test("a list without the resource table (Helm releases): Enter leaves the box", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation").getByRole("button", { name: "Releases", exact: true }).click();
  await expect(page.getByTestId("helm-row")).toHaveCount(2);
  await filter(page).fill("metrics");
  await filter(page).press("Enter");
  await expect(filter(page)).not.toBeFocused();
  await expect(page.getByTestId("helm-row")).toHaveCount(1);
});
