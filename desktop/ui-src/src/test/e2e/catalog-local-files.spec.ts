import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// Local credential files in the catalog (#244): an added kubeconfig whose
// user sends a token file or client certificate from outside its own
// folder is checked only when the user asks, and the row says which files.

const catalogRow = (page: Page, id: string) => page.locator(`[data-testid="catalog-row"][data-context="${id}"]`);
const TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const PASTED = "/home/user/.config/dev.kubeloupe.app/kubeconfigs";

function kubeconfig(name: string, user: string): string {
  return (
    "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster: {server: https://attacker.example}\n" +
    `users:\n- name: u\n  user:\n${user}\ncontexts:\n- name: ${name}\n  context: {cluster: c, user: u}\n`
  );
}

async function paste(page: Page, yaml: string) {
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await expect(page.getByTestId("catalog")).toBeVisible();
  await page.getByRole("button", { name: "Add kubeconfig…" }).click();
  await page.getByRole("radio", { name: "Paste a kubeconfig" }).check();
  await page.getByRole("textbox", { name: "Kubeconfig YAML" }).fill(yaml);
  await page.getByRole("button", { name: "Save and add" }).click();
}

const checksOf = async (fake: Awaited<ReturnType<typeof openApp>>, id: string) =>
  (await fake.calls("cmdCheckContext")).filter((c) => c.name === id);

test("an added context that sends a local token file is checked only on click", async ({ page }) => {
  const fake = await openApp(page);
  await paste(page, kubeconfig("stolen", `    tokenFile: ${TOKEN}\n    client-key: /home/user/.ssh/id.key`));

  const row = catalogRow(page, "stolen");
  const status = row.getByTestId("catalog-status");
  await expect(row.getByTestId("catalog-local-files")).toHaveText(
    `Sends local files: ${TOKEN}, /home/user/.ssh/id.key`,
  );
  const check = status.getByRole("button", { name: "Check stolen" });
  await expect(check).toHaveAttribute("title", `Logging in sends ${TOKEN}, /home/user/.ssh/id.key`);
  // Adding it checked the other new contexts only: nothing was sent.
  await expect(catalogRow(page, "kind-dev").getByTestId("catalog-status")).toHaveText("Connected");
  expect(await checksOf(fake, "stolen")).toEqual([]);

  // Check all does not send them either: the backend refuses, the row still waits.
  await page.getByRole("button", { name: "Check all" }).click();
  await expect.poll(() => checksOf(fake, "stolen")).toEqual([{ name: "stolen", asked: false }]);
  await expect(check).toBeVisible();
  await expect(status).not.toContainText("Connected");

  // A click is the user's choice.
  await check.click();
  await expect(status).toContainText("Connected");
  expect((await checksOf(fake, "stolen")).at(-1)).toEqual({ name: "stolen", asked: true });
  await expect(row.getByTestId("catalog-local-files")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("the More menu's Check connection counts as asking", async ({ page }) => {
  const fake = await openApp(page);
  await paste(page, kubeconfig("cert-user", "    client-certificate: /home/user/.kube/me.crt"));
  const row = catalogRow(page, "cert-user");
  await expect(row.getByTestId("catalog-local-files")).toHaveText("Sends local files: /home/user/.kube/me.crt");
  await row.getByRole("button", { name: "More actions for cert-user" }).click();
  await page.getByRole("menuitem", { name: "Check connection" }).click();
  await expect(row.getByTestId("catalog-status")).toContainText("Connected");
  expect(await checksOf(fake, "cert-user")).toEqual([{ name: "cert-user", asked: true }]);
});

test("allowing an added source's login command does not send its local files", async ({ page }) => {
  const fake = await openApp(page);
  const user =
    "    client-key: /home/user/.ssh/id.key\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n" +
    "      command: aws\n      args: [eks, get-token]";
  await paste(page, kubeconfig("exec-cert", user));

  // Adding it opened the prompt by itself: it names the files too.
  const prompt = page.getByRole("alertdialog", { name: "Allow login command" });
  await expect(prompt.getByTestId("exec-local-files")).toHaveText("Also sends local files: /home/user/.ssh/id.key");
  await prompt.getByRole("button", { name: "Allow and check" }).click();
  await expect.poll(() => checksOf(fake, "exec-cert")).toEqual([{ name: "exec-cert", asked: false }]);
  const row = catalogRow(page, "exec-cert");
  await expect(row.getByTestId("catalog-status").getByRole("button", { name: "Check exec-cert" })).toBeVisible();
  expect(await page.evaluate(() => window.__fake.cluster.catalog.pluginRuns)).toEqual({});

  // Its own Check is the user's choice.
  await row.getByRole("button", { name: "Check exec-cert" }).click();
  await expect(row.getByTestId("catalog-status")).toContainText("Connected");
  expect((await checksOf(fake, "exec-cert")).at(-1)).toEqual({ name: "exec-cert", asked: true });
});

test("files in the added kubeconfig's own folder are checked as before", async ({ page }) => {
  const fake = await openApp(page);
  await paste(page, kubeconfig("own-cert", `    client-certificate: ${PASTED}/own.crt`));
  const row = catalogRow(page, "own-cert");
  await expect(row.getByTestId("catalog-status")).toHaveText("Connected");
  await expect(row.getByTestId("catalog-local-files")).toHaveCount(0);
  expect(await checksOf(fake, "own-cert")).toEqual([{ name: "own-cert", asked: false }]);
});
