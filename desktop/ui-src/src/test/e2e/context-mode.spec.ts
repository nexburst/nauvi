// Read-only and protected contexts (#338). The backend's gate (emulated by
// the fake, `fake/gate.ts`) refuses changes on a read-only context and
// wants the context name typed on a protected one; the UI shows a badge,
// greys out what read-only refuses (with RBAC, #340) and asks for the name.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

const menu = (page: Page) => page.getByRole("menu");
const actionDialog = (page: Page) => page.getByTestId("action-dialog");
const confirmDialog = (page: Page) => page.getByTestId("protected-confirm");
const header = (page: Page) => page.locator("header");

async function contextMenu(page: Page, name: string) {
  await row(page, name).click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  return menu(page);
}

// Init functions run in the page as source text: no captured variables.
const readOnlyDev = (cluster: FakeCluster) => {
  cluster.settings.contexts["kind-dev"] = {
    view: "",
    namespaces: [],
    typed_namespaces: [],
    prometheus: "",
    display_name: "",
    color: "",
    default_namespace: "",
    shell_cwd: "",
    last_used: 0,
    hide_metrics: false,
    mode: "readOnly",
  };
};
const protectedDev = (cluster: FakeCluster) => {
  cluster.settings.contexts["kind-dev"] = {
    view: "",
    namespaces: [],
    typed_namespaces: [],
    prometheus: "",
    display_name: "",
    color: "",
    default_namespace: "",
    shell_cwd: "",
    last_used: 0,
    hide_metrics: false,
    mode: "protected",
  };
};

test("a read-only context shows its badge and greys out every change", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.contexts["kind-dev"] = {
      view: "",
      namespaces: [],
      typed_namespaces: [],
      prometheus: "",
      display_name: "",
      color: "",
      default_namespace: "",
      shell_cwd: "",
      last_used: 0,
      hide_metrics: false,
      mode: "readOnly",
    };
    // RBAC refuses the shell too: read-only is the reason shown.
    cluster.deniedActions = { shell: "Not allowed: you can't create pods/exec in namespace demo" };
  });
  await expect(header(page).getByTestId("context-mode-badge")).toHaveText("Read-only");
  await expect(header(page).getByTestId("context-mode-badge")).toHaveAttribute(
    "title",
    "kind-dev is read-only: changes to this cluster are turned off",
  );
  await openKind(page, "Pods");
  const m = await contextMenu(page, "web-1");
  const reason = "kind-dev is read-only: changes to this cluster are turned off";
  for (const name of ["Shell", "Attach", "Debug…", "Evict", "Delete", "Force delete…"]) {
    const item = m.getByRole("menuitem", { name, exact: true });
    await expect(item, name).toBeDisabled();
    await expect(item, name).toHaveAttribute("title", reason);
  }
  // Reading still works: logs and port-forwards.
  await expect(m.getByRole("menuitem", { name: "Logs" })).toBeEnabled();
  await expect(m.getByRole("menuitem", { name: "Port forward…" })).toBeEnabled();
  await page.keyboard.press("Escape");
  expect(await fake.calls("cmdRunAction")).toEqual([]);

  // The catalog shows it too.
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  const devRow = page.locator('[data-testid="catalog-row"][data-context="kind-dev"]');
  await expect(devRow.getByTestId("context-mode-badge")).toHaveText("Read-only");
  await expect(page.locator('[data-testid="catalog-row"][data-context="prod"]').getByTestId("context-mode-badge")).toHaveCount(0);
});

test("a read-only context refuses a change that reaches the backend", async ({ page }) => {
  const fake = await openApp(page, readOnlyDev);
  await openKind(page, "Config Maps");
  await page.getByRole("button", { name: "+ Create" }).click();
  const create = page.getByRole("dialog", { name: "Create resources" });
  await expect(create.locator(".code-editor")).toHaveAttribute("data-ready", "true");
  // Even a dry run: read-only refuses everything that would write.
  await create.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(create).toContainText("kind-dev is read-only: changes to this cluster are turned off");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create).toContainText("kind-dev is read-only: changes to this cluster are turned off");
  expect(await fake.calls("cmdApplyManifests")).toEqual([]);
});

test("a protected context asks for the context name before each change", async ({ page }) => {
  const fake = await openApp(page, protectedDev);
  await expect(header(page).getByTestId("context-mode-badge")).toHaveText("Protected");
  await openKind(page, "Deployments");

  // Cancel: nothing is deleted, and the action dialog says so.
  await (await contextMenu(page, "web")).getByRole("menuitem", { name: "Delete" }).click();
  await actionDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirmDialog(page)).toBeVisible();
  await expect(confirmDialog(page)).toContainText("Delete Deployment demo/web");
  await expect(confirmDialog(page)).toContainText("Type kind-dev to confirm");
  await confirmDialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(actionDialog(page)).toContainText("Cancelled: nothing was changed");
  expect(await fake.calls("cmdRunAction")).toEqual([]);
  await actionDialog(page).getByRole("button", { name: "Cancel" }).click();

  // The name must match exactly.
  await (await contextMenu(page, "web")).getByRole("menuitem", { name: "Delete" }).click();
  await actionDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
  const input = confirmDialog(page).getByTestId("protected-confirm-input");
  const ok = confirmDialog(page).getByTestId("protected-confirm-button");
  await expect(input).toBeFocused();
  await input.fill("kind-de");
  await expect(ok).toBeDisabled();
  await input.press("Enter");
  await expect(confirmDialog(page)).toBeVisible();
  await input.fill("kind-dev");
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(actionDialog(page)).toHaveCount(0);
  expect(await fake.lastCall("cmdRunAction")).toMatchObject({ namespace: "demo", name: "web", action: "delete" });
  await expect(page.getByRole("status")).toContainText("Deleted deployment demo/web");
});

test("Escape in the confirmation cancels only the confirmation", async ({ page }) => {
  const fake = await openApp(page, protectedDev);
  await openKind(page, "Deployments");
  await (await contextMenu(page, "web")).getByRole("menuitem", { name: "Delete" }).click();
  await actionDialog(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirmDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmDialog(page)).toHaveCount(0);
  await expect(actionDialog(page)).toBeVisible();
  expect(await fake.calls("cmdRunAction")).toEqual([]);
});

test("the mode is set on the cluster's settings page and survives other changes", async ({ page }) => {
  await openApp(page);
  await expect(header(page).getByTestId("context-mode-badge")).toHaveCount(0);
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await page.getByRole("button", { name: "More actions for kind-dev", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  const dialog = page.getByRole("dialog", { name: "Cluster settings" });
  await expect(dialog.getByRole("radio", { name: /Normal/ })).toBeChecked();
  await dialog.getByRole("radio", { name: /Protected/ }).check();
  await expect.poll(() => page.evaluate(() => window.__fake.cluster.settings.contexts["kind-dev"]?.mode)).toBe("protected");
  await expect(header(page).getByTestId("context-mode-badge")).toHaveText("Protected");
  // Another field saved afterwards keeps the mode.
  await dialog.getByRole("textbox", { name: "Display name" }).fill("Dev");
  await dialog.getByRole("textbox", { name: "Display name" }).press("Tab");
  await expect.poll(() => page.evaluate(() => window.__fake.cluster.settings.contexts["kind-dev"]?.display_name)).toBe("Dev");
  expect(await page.evaluate(() => window.__fake.cluster.settings.contexts["kind-dev"]?.mode)).toBe("protected");
  await dialog.getByRole("radio", { name: /Read-only/ }).check();
  await expect(header(page).getByTestId("context-mode-badge")).toHaveText("Read-only");
  await dialog.getByRole("radio", { name: /Normal/ }).check();
  await expect(header(page).getByTestId("context-mode-badge")).toHaveCount(0);
});
