import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// The notification history (#326): the bell in the header and its side panel.

const bell = (page: Page) => page.getByTestId("notification-bell");
const panel = (page: Page) => page.getByTestId("notifications-panel");
const items = (page: Page) => panel(page).getByTestId("notification");

async function runFromMenu(page: Page, name: string, item: string) {
  await row(page, name).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

test("the panel starts empty and the bell has no count", async ({ page }) => {
  const fake = await openApp(page);
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("notifications-empty")).toContainText("No notifications yet");
  await expect(panel(page).getByRole("button", { name: "Clear all" })).toBeDisabled();
  await panel(page).getByRole("button", { name: "Close notifications" }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("notices and errors land in the history with an unread count", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Nodes");
  await runFromMenu(page, "node-2", "Cordon");
  await expect(page.getByRole("status")).toContainText("Cordoned Node/node-2");
  await fake.failNext("cmdRunAction", 'nodes "node-1" is forbidden');
  await runFromMenu(page, "node-1", "Cordon");
  await expect(page.getByRole("alert")).toContainText("is forbidden");

  await expect(page.getByTestId("notification-count")).toHaveText("2");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 2 unread");
  await bell(page).click();
  // Opening the panel reads them all.
  await expect(page.getByTestId("notification-count")).toHaveCount(0);

  await expect(items(page)).toHaveCount(2);
  await expect(items(page).nth(0)).toHaveClass(/error/);
  await expect(items(page).nth(0)).toContainText('Cordon node-1: nodes "node-1" is forbidden');
  await expect(items(page).nth(0)).toContainText("Error");
  await expect(items(page).nth(1)).toHaveClass(/success/);
  await expect(items(page).nth(1)).toContainText("Cordoned Node/node-2");
  // The time, and the context the window was on.
  await expect(items(page).nth(1).locator("time")).toHaveText(/^\d\d:\d\d:\d\d$/);
  await expect(items(page).nth(1).locator(".context")).not.toBeEmpty();

  // The panel is a popover: working in the table puts it away, and what
  // arrives meanwhile is unread until it is opened again.
  await runFromMenu(page, "node-2", "Uncordon");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("notification-count")).toHaveText("1");
  await bell(page).click();
  await expect(items(page)).toHaveCount(3);
  await expect(page.getByTestId("notification-count")).toHaveCount(0);

  await panel(page).getByRole("button", { name: "Clear all" }).click();
  await expect(items(page)).toHaveCount(0);
  await expect(page.getByTestId("notifications-empty")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("a notification links to its object", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");
  await runFromMenu(page, "web", "Rollout restart");
  await expect(page.getByRole("status")).toBeVisible();
  // Somewhere else, then back to the object from the history.
  await openKind(page, "Pods");
  await bell(page).click();
  await items(page).nth(0).getByRole("button", { name: "Deployment demo/web" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("detail-panel")).toContainText("web");
});

test("the same error repeated is folded into one entry", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Nodes");
  for (let i = 0; i < 3; i++) {
    await fake.failNext("cmdRunAction", "the server is busy");
    await runFromMenu(page, "node-1", "Cordon");
    await expect(page.getByRole("alert")).toContainText("busy");
  }
  await bell(page).click();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).nth(0)).toContainText("×3");
});
