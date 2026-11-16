import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { namespaceButton, openApp, openKind, row, toggleNamespaces } from "./helpers";

// Back/forward (#223): the view, the namespaces and the detail panel's object.

const back = (page: Page) => page.getByRole("button", { name: "Go back", exact: true });
const forward = (page: Page) => page.getByRole("button", { name: "Go forward", exact: true });
const grid = (page: Page) => page.getByRole("grid");
const panelTitle = (page: Page) => page.getByTestId("detail-panel").locator(".title");
const filter = (page: Page) => page.locator("#table-filter");

/** The mouse's back (3) or forward (4) button, as the engine reports it. */
async function mouseButton(page: Page, button: 3 | 4) {
  await page.evaluate((b) => {
    const el = document.querySelector("main, .main") ?? document.body;
    for (const type of ["mousedown", "mouseup"]) {
      el.dispatchEvent(new MouseEvent(type, { button: b, bubbles: true, cancelable: true }));
    }
  }, button);
}

test("the header arrows and Alt+Left/Right move through views and objects", async ({ page }) => {
  const fake = await openApp(page);
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeDisabled();

  await openKind(page, "Pods");
  await expect(grid(page)).toHaveAccessibleName("Pods");
  await expect(back(page)).toBeEnabled();
  await row(page, "web-1").click();
  await expect(panelTitle(page)).toHaveText("demo/web-1");
  await row(page, "web-2").click();
  await expect(panelTitle(page)).toHaveText("demo/web-2");

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(panelTitle(page)).toHaveText("demo/web-1");
  await back(page).click();
  await expect(panelTitle(page)).toHaveCount(0);
  await expect(grid(page)).toHaveAccessibleName("Pods");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(grid(page)).toHaveCount(0);
  await expect(back(page)).toBeDisabled();
  // At the start, another Back does nothing.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(back(page)).toBeDisabled();

  await forward(page).click();
  await expect(grid(page)).toHaveAccessibleName("Pods");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(panelTitle(page)).toHaveText("demo/web-1");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(panelTitle(page)).toHaveText("demo/web-2");
  await expect(forward(page)).toBeDisabled();

  // Going somewhere new from the middle drops what was ahead.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(panelTitle(page)).toHaveText("demo/web-1");
  await openKind(page, "Deployments");
  await expect(grid(page)).toHaveAccessibleName("Deployments");
  await expect(forward(page)).toBeDisabled();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(panelTitle(page)).toHaveText("demo/web-1");
  expect(fake.errors).toEqual([]);
});

test("typing in the filter adds no entries, and Alt+arrows stay with the field", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panelTitle(page)).toHaveText("demo/web-1");

  await filter(page).click();
  await page.keyboard.type("web");
  await page.keyboard.press("Alt+ArrowLeft");
  // Still in the field, with the same object: the key moved the caret.
  await expect(filter(page)).toBeFocused();
  await expect(panelTitle(page)).toHaveText("demo/web-1");

  // One step back is the table without the panel, not a filter keystroke.
  await back(page).click();
  await expect(panelTitle(page)).toHaveCount(0);
  await expect(grid(page)).toHaveAccessibleName("Pods");
  await back(page).click();
  await expect(grid(page)).toHaveCount(0);
});

test("the namespace selection is part of a place", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await toggleNamespaces(page, "demo");
  await expect(namespaceButton(page)).toHaveText("demo");
  await row(page, "web-1").click();
  await expect(panelTitle(page)).toHaveText("demo/web-1");

  await back(page).click();
  await expect(panelTitle(page)).toHaveCount(0);
  await expect(namespaceButton(page)).toHaveText("demo");
  await back(page).click();
  await expect(namespaceButton(page)).toHaveText("All namespaces");
  await forward(page).click();
  await expect(namespaceButton(page)).toHaveText("demo");
});

test("the mouse's back and forward buttons", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panelTitle(page)).toHaveText("demo/web-1");

  await mouseButton(page, 3);
  await expect(panelTitle(page)).toHaveCount(0);
  await mouseButton(page, 3);
  await expect(grid(page)).toHaveCount(0);
  await mouseButton(page, 4);
  await expect(grid(page)).toHaveAccessibleName("Pods");

  // Not behind a dialog.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await mouseButton(page, 3);
  await page.keyboard.press("Escape");
  await expect(grid(page)).toHaveAccessibleName("Pods");
});

test("back to an object deleted since shows that it was deleted", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panelTitle(page)).toHaveText("demo/web-1");
  await row(page, "web-2").click();
  await expect(panelTitle(page)).toHaveText("demo/web-2");

  await fake.setCluster((c) => {
    c.rows["v1/pods"] = c.rows["v1/pods"].filter((r) => r.key !== "demo/web-1");
  }, null);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(panelTitle(page)).toHaveText("demo/web-1");
  await expect(page.getByText("This Pod was deleted.")).toBeVisible();
  await expect(page.getByText(/Could not load pod details/)).toHaveCount(0);
  // And forward again to one that exists.
  await page.keyboard.press("Alt+ArrowRight");
  await expect(panelTitle(page)).toHaveText("demo/web-2");
  await expect(page.getByText("This Pod was deleted.")).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("a context switch clears the history", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(back(page)).toBeEnabled();

  await page.getByLabel("Cluster context").selectOption("prod");
  await expect(panelTitle(page)).toHaveCount(0);
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeDisabled();
  await openKind(page, "Deployments");
  await back(page).click();
  await expect(grid(page)).toHaveCount(0);
  await expect(back(page)).toBeDisabled();
});

test("the shortcuts are listed in the help", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toContainText("Back to the previous view, namespaces or object");
  await expect(help).toContainText("Forward again");
});
