import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// The cluster catalog (#78): every context from every kubeconfig source,
// with its status; adding files, folders and pasted kubeconfigs; pins.

const catalogView = (page: Page) => page.getByTestId("catalog");
const catalogRow = (page: Page, id: string) => page.locator(`[data-testid="catalog-row"][data-context="${id}"]`);
const contextSelect = (page: Page) => page.getByRole("combobox", { name: "Cluster context" });
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

async function openCatalog(page: Page) {
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await expect(catalogView(page)).toBeVisible();
}

test("the catalog lists every context with its status and source, checked on open", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.catalog.checks["prod"] = {
      name: "prod",
      state: "auth_error",
      message: "Login to `prod` failed: `aws` exited with exit code 255: SSO session expired",
      version: "",
    };
  });
  await openCatalog(page);
  await expect(catalogRow(page, "kind-dev").getByTestId("catalog-status")).toHaveText("Connected");
  await expect(catalogRow(page, "kind-dev")).toContainText("this window");
  await expect(catalogRow(page, "kind-dev")).toContainText("https://kind-dev.example:6443");
  await expect(catalogRow(page, "kind-dev")).toContainText("/home/user/.kube/config");
  const prod = catalogRow(page, "prod");
  await expect(prod.getByTestId("catalog-status")).toContainText("Login failed");
  await expect(prod.getByTestId("catalog-status-message")).toContainText("SSO session expired");
  // The default kubeconfig cannot be removed from here.
  await expect(prod.getByRole("button", { name: /Remove/ })).toHaveCount(0);
  await expect(page.getByTestId("catalog-source")).toHaveText(/Kubeconfig\s*\/home\/user\/.kube\/config\s*2 contexts/);
  await expect(page.getByTestId("catalog-source").getByRole("button", { name: /Remove/ })).toHaveCount(0);
  expect((await fake.calls("cmdCheckContext")).map((c) => c.name).sort()).toEqual(["kind-dev", "prod"]);

  // Check again on demand.
  await prod.getByRole("button", { name: "Check prod" }).click();
  await expect.poll(async () => (await fake.calls("cmdCheckContext")).length).toBe(3);
  expect(fake.errors).toEqual([]);
});

test("an added kubeconfig file brings its contexts everywhere, disambiguated", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.catalog.files["/home/user/work/team.yaml"] = [
      { name: "prod (team.yaml)", context: "prod", current: false, namespace: null, server: "https://team.example" },
      { name: "staging", current: false, namespace: "web" },
    ];
  });
  await openCatalog(page);
  await page.getByRole("button", { name: "Add kubeconfig…" }).click();
  const path = page.getByRole("textbox", { name: "Kubeconfig file or folder" });

  // A path that does not exist is refused, with the reason.
  await path.fill("~/work/nope.yaml");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("catalog-error")).toHaveText(
    "cannot add /home/user/work/nope.yaml: No such file or directory (os error 2)",
  );

  await path.fill("~/work/team.yaml");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(path).toHaveCount(0);
  await expect(page.getByTestId("catalog-error")).toHaveCount(0);
  await expect(catalogRow(page, "prod (team.yaml)")).toContainText("Added file");
  await expect(catalogRow(page, "staging")).toContainText("/home/user/work/team.yaml");
  // The new contexts are checked as they arrive.
  await expect(catalogRow(page, "staging").getByTestId("catalog-status")).toHaveText("Connected");
  await expect(page.getByTestId("catalog-source")).toHaveCount(2);
  expect(await page.evaluate(() => window.__fake.cluster.settings.kubeconfig_sources)).toEqual([
    "/home/user/work/team.yaml",
  ]);

  // In the context selector and the palette, by id.
  await expect(contextSelect(page).locator("option")).toHaveText(["kind-dev", "prod", "prod (team.yaml)", "staging"]);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("ctx team");
  await expect(palette(page).getByRole("option").first()).toContainText("prod (team.yaml)");
  await page.keyboard.press("Escape");

  // Open in a new window, or here.
  await catalogRow(page, "staging").getByRole("button", { name: "Open staging in new window" }).click();
  await expect.poll(() => fake.calls("cmdOpenWindow")).toEqual([{ context: "staging" }]);
  await catalogRow(page, "prod (team.yaml)").getByRole("button", { name: "Open prod (team.yaml)", exact: true }).click();
  await expect.poll(() => fake.calls("cmdSetContext")).toEqual([{ name: "prod (team.yaml)" }]);
  await expect(contextSelect(page)).toHaveValue("prod (team.yaml)");
  await expect(page.getByRole("navigation").getByRole("button", { name: "Overview" })).toHaveClass(/active/);
  expect(fake.errors).toEqual([]);
});

test("a pasted kubeconfig is saved and added; removing it asks first", async ({ page }) => {
  const fake = await openApp(page);
  await openCatalog(page);
  await page.getByRole("button", { name: "Add kubeconfig…" }).click();
  await page.getByRole("radio", { name: "Paste a kubeconfig" }).check();
  const yaml = page.getByRole("textbox", { name: "Kubeconfig YAML" });

  await yaml.fill("hello: world");
  await page.getByRole("button", { name: "Save and add" }).click();
  await expect(page.getByTestId("catalog-error")).toContainText("The pasted text is not a kubeconfig");

  await yaml.fill(
    "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: https://x}\n" +
      "users:\n- name: u\n  user: {token: t}\ncontexts:\n- name: prod\n  context: {cluster: c, user: u}\n",
  );
  await page.getByRole("textbox", { name: "Name (optional)" }).fill("lab");
  await page.getByRole("button", { name: "Save and add" }).click();
  const pasted = catalogRow(page, "prod (lab.yaml)");
  await expect(pasted).toContainText("Pasted");
  expect(await fake.lastCall("cmdPasteKubeconfig")).toMatchObject({ name: "lab" });

  await pasted.getByRole("button", { name: "Remove prod (lab.yaml)'s source" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove source" });
  await expect(confirm).toContainText("The pasted kubeconfig saved by kubeloupe is deleted.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(pasted).toBeVisible();
  expect(await fake.calls("cmdRemoveKubeconfigSource")).toEqual([]);

  await pasted.getByRole("button", { name: "Remove prod (lab.yaml)'s source" }).click();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(pasted).toHaveCount(0);
  expect(await fake.calls("cmdRemoveKubeconfigSource")).toEqual([
    { path: "/home/user/.config/dev.kubeloupe.app/kubeconfigs/lab.yaml" },
  ]);
  expect(await page.evaluate(() => window.__fake.cluster.settings.kubeconfig_sources)).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("pinned clusters come first in the selector and the palette", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.contexts.push({ name: "staging", current: false, namespace: null });
  });
  await openCatalog(page);
  await catalogRow(page, "staging").getByRole("button", { name: "Pin staging" }).click();
  await expect(catalogRow(page, "staging").getByRole("button", { name: "Unpin staging" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The pinned row moves to the top of the catalog too.
  await expect(page.getByTestId("catalog-row").first()).toHaveAttribute("data-context", "staging");
  await expect(contextSelect(page).locator("optgroup")).toHaveCount(2);
  await expect(contextSelect(page).locator('optgroup[label="Pinned"] option')).toHaveText(["staging"]);
  await expect(contextSelect(page).locator('optgroup[label="All clusters"] option')).toHaveText(["kind-dev", "prod"]);

  await page.keyboard.press("ControlOrMeta+k");
  const first = palette(page).getByRole("option").first();
  await expect(first).toContainText("staging");
  await page.keyboard.press("Enter");
  await expect(contextSelect(page)).toHaveValue("staging");

  // Pins are remembered.
  await page.reload();
  await expect(contextSelect(page).locator('optgroup[label="Pinned"] option')).toHaveText(["staging"]);
});

test("a change to the kubeconfig files reloads the contexts", async ({ page }) => {
  const fake = await openApp(page);
  await openCatalog(page);
  await fake.setCluster((cluster) => {
    cluster.contexts.push({ name: "new-one", current: false, namespace: null });
  }, null);
  await page.evaluate(() => window.__fake.emitKubeconfigsChanged());
  await expect(catalogRow(page, "new-one")).toBeVisible();
  await expect(contextSelect(page).locator("option")).toHaveText(["kind-dev", "prod", "new-one"]);
});

test("the catalog is in the command palette", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("catalog");
  await page.keyboard.press("Enter");
  await expect(catalogView(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cluster catalog" })).toHaveClass(/active/);
});
