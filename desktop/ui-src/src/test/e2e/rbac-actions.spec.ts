// Actions follow RBAC in the table (#340): the row menu and the bulk bar
// grey out what a SelfSubjectAccessReview refuses, saying which permission
// is missing. (The detail panel's bar: detail-actions.spec.ts.)
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

const menu = (page: Page) => page.getByRole("menu");
const dialog = (page: Page) => page.getByRole("alertdialog");
const bulk = (page: Page) => page.getByRole("toolbar", { name: "Selection" });

async function contextMenu(page: Page, name: string) {
  await row(page, name).click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  return menu(page);
}

test("the row menu greys out refused actions with the missing permission", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.deniedActions = {
      shell: "Not allowed: you can't create pods/exec in namespace demo",
      delete: "Not allowed: you can't delete pods in namespace demo",
    };
  });
  await openKind(page, "Pods");
  const m = await contextMenu(page, "web-1");
  const shell = m.getByRole("menuitem", { name: "Shell" });
  const del = m.getByRole("menuitem", { name: "Delete", exact: true });
  await expect(shell).toBeDisabled();
  await expect(del).toBeDisabled();
  await expect(shell).toHaveAccessibleDescription("Not allowed: you can't create pods/exec in namespace demo");
  await expect(shell).toHaveAttribute("title", "Not allowed: you can't create pods/exec in namespace demo");
  await expect(m.getByTestId("menu-reason")).toHaveText([
    "Not allowed: you can't create pods/exec in namespace demo",
    "Not allowed: you can't delete pods in namespace demo",
  ]);
  // The rest is offered; Copy link is never checked.
  await expect(m.getByRole("menuitem", { name: "Logs" })).toBeEnabled();
  await expect(m.getByRole("menuitem", { name: "Copy link" })).toBeEnabled();
  expect((await fake.lastCall("cmdCheckActions"))?.ids).toEqual([
    "logs",
    "shell",
    "attach",
    "debug",
    "edit",
    "portForward",
    "evict",
    "delete",
    "forceDelete",
  ]);

  // The keyboard skips them too: Enter on the last enabled item, never Delete.
  await page.keyboard.press("End");
  await expect(m.getByRole("menuitem", { name: "Force delete…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdRunAction")).toEqual([]);
});

test("the row menu asks about the row's own namespace", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.deniedActions = {
      "kube-system/delete": "Not allowed: you can't delete pods in namespace kube-system",
    };
  });
  await openKind(page, "Pods");
  let m = await contextMenu(page, "coredns-1");
  await expect(m.getByRole("menuitem", { name: "Delete", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  m = await contextMenu(page, "web-1");
  await expect(m.getByRole("menuitem", { name: "Logs" })).toBeEnabled();
  await expect(m.getByRole("menuitem", { name: "Delete", exact: true })).toBeEnabled();
  await expect(m.getByTestId("menu-reason")).toHaveCount(0);
});

test("bulk delete is refused when one namespace of the selection refuses it", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.deniedActions = {
      "kube-system/delete": "Not allowed: you can't delete pods in namespace kube-system",
    };
  });
  await openKind(page, "Pods");
  await row(page, "web-1").getByRole("checkbox").check();
  await expect(bulk(page).getByRole("button", { name: "Delete 1…" })).not.toHaveAttribute("aria-disabled");

  await row(page, "coredns-1").getByRole("checkbox").check();
  const del = bulk(page).getByRole("button", { name: "Delete 2…" });
  await expect(del).toHaveAttribute("aria-disabled", "true");
  await expect(del).toHaveAccessibleDescription("Not allowed: you can't delete pods in namespace kube-system");
  await expect(bulk(page).getByTestId("bulk-reason")).toHaveText(
    "Not allowed: you can't delete pods in namespace kube-system",
  );
  await del.click({ force: true });
  await expect(dialog(page)).toHaveCount(0);

  // The row menu of the selection says the same.
  const m = await contextMenu(page, "web-1");
  await expect(m.getByRole("menuitem", { name: "Delete 2 selected…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(await fake.calls("cmdBulkDelete")).toEqual([]);

  // Without the refused namespace it is offered again.
  await row(page, "coredns-1").getByRole("checkbox").uncheck();
  await expect(bulk(page).getByRole("button", { name: "Delete 1…" })).not.toHaveAttribute("aria-disabled");
  await expect(bulk(page).getByTestId("bulk-reason")).toHaveCount(0);
});

test("a failed access check offers every menu item", async ({ page }) => {
  await openApp(page, (_cluster, fake) => fake.failNext("cmdCheckActions", "the API server is down"));
  await openKind(page, "Pods");
  const m = await contextMenu(page, "web-1");
  await expect(m.getByRole("menuitem", { name: "Shell" })).toBeEnabled();
  await expect(m.getByTestId("menu-reason")).toHaveCount(0);
});
