import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// Evict one pod through the Eviction API (#300).

const menu = (page: Page) => page.getByRole("menu");
const dialog = (page: Page) => page.getByRole("alertdialog");
const panel = (page: Page) => page.getByTestId("detail-panel");
const bar = (page: Page) => panel(page).getByRole("toolbar", { name: "Actions" });

const PDB_BLOCK =
  "Blocked by a PodDisruptionBudget: evicting would leave too few pods running. " +
  "Cannot evict pod as it would violate the pod's disruption budget. " +
  "The disruption budget web needs 1 healthy pods and has 1 currently";

test("Evict from the row menu asks first, then evicts", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Evict", exact: true }).click();

  await expect(dialog(page)).toHaveAccessibleName("Evict Pod");
  await expect(dialog(page)).toContainText("evict the pod");
  await expect(dialog(page)).toContainText("PodDisruptionBudget");
  await expect(dialog(page).getByRole("listitem")).toHaveText(["demo/web-1"]);
  expect(await fake.calls("cmdRunAction")).toEqual([]);

  await dialog(page).getByRole("button", { name: "Evict", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.lastCall("cmdRunAction")).toMatchObject({ namespace: "demo", name: "web-1", action: "evict" });
  await expect(page.getByRole("status")).toContainText("Evicted Pod/demo/web-1");
  await expect(row(page, "web-1")).toHaveCount(0);
});

test("a PodDisruptionBudget block is shown in the dialog with the server's message", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await fake.setCluster(
    (cluster, text) => {
      cluster.evictErrors = { "demo/web-1": text as string };
    },
    PDB_BLOCK,
  );
  await row(page, "web-1").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Evict", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Evict", exact: true }).click();

  await expect(dialog(page)).toContainText(PDB_BLOCK);
  // Nothing was evicted: the dialog stays for another try or Cancel.
  await expect(row(page, "web-1")).toHaveCount(1);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test("the detail panel's Evict runs the same confirmation and closes the panel", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await bar(page).getByRole("button", { name: "Evict", exact: true }).click();
  await expect(dialog(page)).toHaveAccessibleName("Evict Pod");
  await dialog(page).getByRole("button", { name: "Evict", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.lastCall("cmdRunAction")).toMatchObject({ name: "web-1", action: "evict" });
  await expect(panel(page)).toHaveCount(0);
});

test("Evict is greyed when RBAC refuses pods/eviction", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.deniedActions = { evict: "Not allowed: you can't create pods/eviction in namespace demo" };
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  const evict = bar(page).getByRole("button", { name: "Evict", exact: true });
  await expect(evict).toHaveAttribute("aria-disabled", "true");
  await evict.click({ force: true });
  await expect(dialog(page)).toHaveCount(0);
});
