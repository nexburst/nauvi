import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// Exec credential plugins in the catalog (#201): contexts that log in with
// a plugin are checked only when asked, and an added kubeconfig's login
// command runs only once the user saw it and allowed it.

const catalogRow = (page: Page, id: string) => page.locator(`[data-testid="catalog-row"][data-context="${id}"]`);
const prompt = (page: Page) => page.getByRole("alertdialog", { name: "Allow login command" });

async function openCatalog(page: Page) {
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await expect(page.getByTestId("catalog")).toBeVisible();
}

const EKS_YAML =
  "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: https://eks.example}\n" +
  "users:\n- name: aws\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n" +
  "      command: aws\n      args: [eks, get-token, --cluster-name, prod]\n" +
  "contexts:\n- name: eks-prod\n  context: {cluster: c, user: aws}\n";

test("opening the catalog does not run login plugins; they are checked on demand", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    const prod = cluster.contexts.find((c) => c.name === "prod")!;
    prod.login_plugin = true;
    prod.login_command = "aws eks get-token --cluster-name prod";
  });
  await openCatalog(page);
  await expect(catalogRow(page, "kind-dev").getByTestId("catalog-status")).toHaveText("Connected");
  const status = catalogRow(page, "prod").getByTestId("catalog-status");
  const check = status.getByRole("button", { name: "Check prod" });
  await expect(check).toBeVisible();
  await expect(check).toHaveAttribute("title", "Logs in by running aws eks get-token --cluster-name prod");
  expect((await fake.calls("cmdCheckContext")).map((c) => c.name)).toEqual(["kind-dev"]);

  // A default-kubeconfig context is the user's own setup: no prompt.
  await check.click();
  await expect(status).toHaveText("Connected");
  await expect(prompt(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__fake.cluster.catalog.pluginRuns)).toEqual({ prod: 1 });
  expect(fake.errors).toEqual([]);
});

test("a pasted kubeconfig's exec command is shown and runs only once allowed", async ({ page }) => {
  const fake = await openApp(page);
  await openCatalog(page);
  await page.getByRole("button", { name: "Add kubeconfig…" }).click();
  await page.getByRole("radio", { name: "Paste a kubeconfig" }).check();
  await page.getByRole("textbox", { name: "Kubeconfig YAML" }).fill(EKS_YAML);
  await page.getByRole("button", { name: "Save and add" }).click();

  // Asked right away, with the exact command and who uses it; nothing ran.
  await expect(prompt(page)).toBeVisible();
  await expect(prompt(page).getByTestId("exec-command")).toHaveText("aws eks get-token --cluster-name prod");
  await expect(prompt(page)).toContainText("Used by eks-prod");
  await expect(prompt(page)).toContainText("/home/user/.config/dev.kubeloupe.app/kubeconfigs/eks-prod.yaml");
  const row = catalogRow(page, "eks-prod");
  await expect(row.getByTestId("catalog-status").getByRole("button", { name: "Check eks-prod" })).toBeVisible();
  expect(await fake.calls("cmdCheckContext")).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ name: "eks-prod" })]),
  );

  // Refused: the check says so without running it, and the answer is kept.
  await prompt(page).getByRole("button", { name: "Don't run" }).click();
  await expect(prompt(page)).toHaveCount(0);
  await expect(row.getByTestId("catalog-status")).toContainText("Not allowed");
  await expect(row.getByTestId("catalog-status-message")).toContainText("you chose not to run it");
  expect(await page.evaluate(() => window.__fake.cluster.catalog.pluginRuns)).toEqual({});

  // Check asks again; allowed, it runs and connects.
  await row.getByRole("button", { name: "Check eks-prod" }).click();
  await expect(prompt(page).getByTestId("exec-command")).toHaveText("aws eks get-token --cluster-name prod");
  await prompt(page).getByRole("button", { name: "Allow and check" }).click();
  await expect(row.getByTestId("catalog-status")).toHaveText("Connected");
  expect(await fake.lastCall("cmdAnswerExecCommand")).toEqual({
    source: "/home/user/.config/dev.kubeloupe.app/kubeconfigs/eks-prod.yaml",
    command: "aws eks get-token --cluster-name prod",
    allow: true,
  });
  expect(await page.evaluate(() => window.__fake.cluster.catalog.pluginRuns)).toEqual({ "eks-prod": 1 });

  // Remembered: a later check does not ask.
  await row.getByRole("button", { name: "More actions for eks-prod" }).click();
  await page.getByRole("menuitem", { name: "Check connection" }).click();
  await expect.poll(() => page.evaluate(() => window.__fake.cluster.catalog.pluginRuns["eks-prod"])).toBe(2);
  await expect(prompt(page)).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("a kubeconfig without login commands adds without a prompt", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.catalog.files["/home/user/work/team.yaml"] = [{ name: "staging", current: false, namespace: null }];
  });
  await openCatalog(page);
  await page.getByRole("button", { name: "Add kubeconfig…" }).click();
  await page.getByRole("textbox", { name: "Kubeconfig file or folder" }).fill("~/work/team.yaml");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(catalogRow(page, "staging").getByTestId("catalog-status")).toHaveText("Connected");
  await expect(prompt(page)).toHaveCount(0);
  expect(await fake.calls("cmdExecCommands")).toEqual([{ source: "/home/user/work/team.yaml" }]);
  expect(fake.errors).toEqual([]);
});
