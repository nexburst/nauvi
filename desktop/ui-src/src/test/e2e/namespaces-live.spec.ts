import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { FakeCluster } from "../fixtures/cluster";
import { namespaceButton, namespacePopover, openApp, openKind } from "./helpers";

// #177: namespaces created (or deleted) after the start reach the namespace
// control and the palette's `ns` search.

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const options = (page: Page) => palette(page).getByRole("option");

function addNamespace(c: FakeCluster, name: string) {
  c.namespaces = [...(c.namespaces ?? []), { name, status: "Active", created: Math.floor(Date.now() / 1000), age: "0s" }];
}

test("the namespace control lists a namespace created after the start", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await namespaceButton(page).click();
  await expect(namespacePopover(page).getByRole("checkbox", { name: "qa-new", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await fake.setCluster(addNamespace, "qa-new");
  await namespaceButton(page).click();
  await expect(namespacePopover(page).getByRole("checkbox", { name: "qa-new", exact: true })).toBeVisible();
  await namespacePopover(page).getByRole("checkbox", { name: "qa-new", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(namespaceButton(page)).toHaveText("qa-new");
  expect(fake.errors).toEqual([]);
});

test("the palette's ns search finds a namespace created after the start", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("ns qa-pal");
  await expect(palette(page)).toContainText("No matches");
  await page.keyboard.press("Escape");

  await fake.setCluster(addNamespace, "qa-palette");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("ns qa-pal");
  await expect(options(page)).toHaveText(["qa-palette"]);
  await page.keyboard.press("Enter");
  await expect(namespaceButton(page)).toHaveText("qa-palette");
});

test("Refresh drops a deleted namespace and adds a new one", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  const before = (await fake.calls("cmdListNamespaces")).length;
  await fake.setCluster((c: FakeCluster) => {
    c.namespaces = (c.namespaces ?? []).filter((n) => n.name !== "default");
  }, null);
  await fake.setCluster(addNamespace, "qa-refresh");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(async () => (await fake.calls("cmdListNamespaces")).length).toBeGreaterThan(before);

  await namespaceButton(page).click();
  const popover = namespacePopover(page);
  await expect(popover.getByRole("checkbox", { name: "qa-refresh", exact: true })).toBeVisible();
  await expect(popover.getByRole("checkbox", { name: "default", exact: true })).toHaveCount(0);
});

test("a failing reload keeps the namespaces listed so far", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await fake.failNext("cmdListNamespaces", "connection refused");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await namespaceButton(page).click();
  await expect(namespacePopover(page).getByRole("checkbox", { name: "demo", exact: true })).toBeVisible();
  expect(fake.errors).toEqual([]);
});
