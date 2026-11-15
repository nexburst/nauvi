import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp } from "./helpers";

const MORE = "https://charts.example.com/more";

async function openCharts(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Charts", exact: true }).click();
  await expect(page.getByTestId("helm-charts")).toBeVisible();
}

function chartRow(page: Page, name: string): Locator {
  return page.getByTestId("chart-row").filter({ has: page.getByRole("gridcell", { name, exact: true }) });
}

const chartDetail = (page: Page) => page.getByTestId("chart-detail");
const deployDialog = (page: Page) => page.getByTestId("helm-deploy");

/** Replace an editor's text, as raw text (no auto-indent). */
async function setText(page: Page, editor: Locator, text: string) {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

test("the Charts view lists the newest version of each chart, with README, values and versions", async ({ page }) => {
  const fake = await openApp(page);
  await openCharts(page);
  await expect(page.getByRole("navigation").getByRole("button", { name: "Charts" })).toHaveClass(/active/);
  await expect(page.getByTestId("helm-charts")).toContainText("Repository: example");

  const rows = page.getByTestId("chart-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("example/redis");
  await expect(chartRow(page, "example/web")).toContainText("1.3.0");
  await expect(page.locator("footer")).toContainText("2 of 2 charts");
  expect(await fake.lastCall("cmdHelmSearch")).toEqual({ query: "", allVersions: false });

  // The toolbar filter searches name and description.
  await page.getByLabel("Filter").fill("in-memory");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("example/redis");
  await page.getByLabel("Filter").fill("");

  await chartRow(page, "example/web").click();
  const d = chartDetail(page);
  await expect(d).toContainText("example/web");
  await expect(d.getByTestId("chart-readme")).toContainText("A small web server");
  await expect(d.getByTestId("chart-version")).toHaveText("1.3.0");
  expect(await fake.lastCall("cmdHelmChartVersions")).toEqual({ chart: "example/web" });

  // Another version: its details load.
  await d.getByLabel("Chart version").selectOption("1.2.0");
  await expect(d.getByTestId("chart-version")).toHaveText("1.2.0");
  expect(await fake.lastCall("cmdHelmChartShow")).toEqual({ chart: "example/web", version: "1.2.0" });
  await d.getByRole("tab", { name: "Values" }).click();
  await expect(d.getByRole("textbox", { name: "Default values" })).toContainText("# web 1.2.0");
  await d.getByRole("tab", { name: "Versions" }).click();
  await expect(d.getByTestId("chart-versions").getByRole("listitem")).toHaveCount(2);

  // Escape closes the detail.
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  expect(fake.errors).toEqual([]);
});

test("repositories are added, updated and removed, in the Charts view and in Settings", async ({ page }) => {
  const fake = await openApp(page);
  await openCharts(page);
  await page.getByRole("button", { name: "Manage repositories" }).click();
  const repos = page.getByTestId("helm-repos");
  await expect(repos.getByTestId("helm-repo")).toHaveCount(1);

  // An unreachable URL is refused with helm's reason.
  await repos.getByLabel("Repository name").fill("nowhere");
  await repos.getByLabel("Repository URL").fill("https://nowhere.example.com");
  await repos.getByRole("button", { name: "Add" }).click();
  await expect(repos.getByTestId("helm-repo-warning")).toContainText(
    "Cannot add repository nowhere: looks like \"https://nowhere.example.com\" is not a valid chart repository",
  );
  await expect(repos.getByTestId("helm-repo")).toHaveCount(1);

  // A good one: its charts show up.
  await repos.getByLabel("Repository name").fill("more");
  await repos.getByLabel("Repository URL").fill(MORE);
  await repos.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".notice")).toContainText(`Added repository more (${MORE})`);
  await expect(repos.getByTestId("helm-repo")).toHaveCount(2);
  await expect(repos.getByLabel("Repository name")).toHaveValue("");
  await expect(chartRow(page, "more/cache")).toBeVisible();
  await expect(page.getByTestId("helm-charts")).toContainText("Repositories: example, more");

  // Update: an unreachable repository is a warning, the others still update.
  await fake.setCluster((c, url) => delete c.helm.charts.servers[url], MORE);
  await repos.getByRole("button", { name: "Update all" }).click();
  await expect(repos.getByTestId("helm-repo-warning")).toContainText("Repository more could not be reached");
  await expect(page.locator(".notice")).toContainText("Updated repository example");
  expect(await fake.lastCall("cmdHelmRepoUpdate")).toEqual({ names: [] });

  // Remove asks once more.
  const more = repos.getByTestId("helm-repo").filter({ hasText: "more" });
  await more.getByRole("button", { name: "Remove more" }).click();
  await more.getByRole("button", { name: "Confirm removing more" }).click();
  await expect(repos.getByTestId("helm-repo")).toHaveCount(1);
  expect(await fake.lastCall("cmdHelmRepoRemove")).toEqual({ name: "more" });
  await expect(chartRow(page, "more/cache")).toHaveCount(0);

  // Settings shows the same list.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("helm-repo-settings");
  await expect(settings.getByTestId("helm-repo")).toHaveCount(1);
  await expect(settings).toContainText("https://charts.example.com/stable");
  expect(fake.errors).toEqual([]);
});

test("with no repositories, the Charts view says so and offers to add one", async ({ page }) => {
  await openApp(page, (c) => {
    c.helm.charts.repos = [];
  });
  await openCharts(page);
  await expect(page.getByTestId("helm-charts")).toContainText("No chart repositories configured.");
  await expect(page.getByTestId("helm-repos")).toContainText("No chart repositories yet");
  await expect(page.getByTestId("chart-row")).toHaveCount(0);
});

test("install: edit the values, dry run the manifest, then install and open the release", async ({ page }) => {
  const fake = await openApp(page);
  await openCharts(page);
  await chartRow(page, "example/web").click();
  await chartDetail(page).getByRole("button", { name: "Install…" }).click();

  const dlg = deployDialog(page);
  await expect(dlg.getByRole("heading")).toHaveText("Install example/web");
  await expect(dlg.getByLabel("Release name")).toHaveValue("web");
  await expect(dlg.getByLabel("Namespace", { exact: true })).toHaveValue("default");
  await expect(dlg.getByLabel("Chart version")).toHaveValue("1.3.0");
  const values = dlg.getByRole("textbox", { name: "Values" });
  await expect(values).toContainText("# web 1.3.0");

  // Another version refills the untouched defaults.
  await dlg.getByLabel("Chart version").selectOption("1.2.0");
  await expect(values).toContainText("# web 1.2.0");

  // An invalid name blocks the dry run.
  await dlg.getByLabel("Release name").fill("Web App");
  await expect(dlg).toContainText("Use lowercase letters");
  await expect(dlg.getByTestId("deploy-preview")).toBeDisabled();
  await dlg.getByLabel("Release name").fill("web2");
  await dlg.getByLabel("Namespace", { exact: true }).fill("team-new");

  await setText(page, values, "greeting: hi\nreplicas: 2\n");
  await dlg.getByTestId("deploy-preview").click();
  await expect(dlg.getByTestId("deploy-summary")).toHaveText("Dry run of team-new/web2: 3 objects, nothing changed.");
  const manifest = dlg.getByRole("textbox", { name: "Rendered manifest" });
  await expect(manifest).toContainText('greeting: "hi"');
  await expect(manifest).toContainText("<hidden: reveal to view>");
  expect((await fake.lastCall("cmdHelmInstall")).request).toEqual({
    name: "web2",
    namespace: "team-new",
    chart: "example/web",
    version: "1.2.0",
    values: "greeting: hi\nreplicas: 2\n",
    create_namespace: true,
    dry_run: true,
    reveal: false,
  });

  // Back keeps the edits; the install runs exactly what was previewed.
  await dlg.getByRole("button", { name: "Back" }).click();
  await expect(values).toContainText("greeting: hi");
  await dlg.getByTestId("deploy-preview").click();
  await dlg.getByTestId("deploy-confirm").click();
  await expect(dlg.getByTestId("deploy-result")).toHaveText("Installed team-new/web2 (revision 1).");
  await expect(dlg.getByTestId("deploy-notes")).toHaveText("web2 says hi.");
  const run = (await fake.lastCall("cmdHelmInstall")).request as { dry_run: boolean; values: string };
  expect(run.dry_run).toBe(false);
  expect(run.values).toBe("greeting: hi\nreplicas: 2\n");

  await dlg.getByRole("button", { name: "Open release" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId("helm-releases")).toBeVisible();
  const detail = page.getByTestId("helm-detail");
  await expect(detail).toContainText("team-new/web2");
  await expect(detail.getByTestId("helm-status")).toHaveText("deployed");
  await expect(detail).toContainText("web-1.2.0");
  expect(fake.errors).toEqual([]);
});

test("install failures are shown in the dialog, and Escape cancels", async ({ page }) => {
  const fake = await openApp(page);
  await openCharts(page);
  await chartRow(page, "example/web").click();
  await chartDetail(page).getByRole("button", { name: "Install…" }).click();
  const dlg = deployDialog(page);
  await dlg.getByLabel("Namespace", { exact: true }).fill("demo");
  await dlg.getByTestId("deploy-preview").click();
  await expect(dlg.getByTestId("deploy-error")).toHaveText(
    "Dry run of the install of web failed: cannot re-use a name that is still in use",
  );
  // A namespace that does not exist needs --create-namespace.
  await dlg.getByLabel("Namespace", { exact: true }).fill("elsewhere");
  await dlg.getByLabel("Create the namespace if it is missing").uncheck();
  await dlg.getByTestId("deploy-preview").click();
  await expect(dlg.getByTestId("deploy-error")).toContainText('namespaces "elsewhere" not found');
  expect((await fake.lastCall("cmdHelmInstall")).request).toMatchObject({ create_namespace: false });

  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(fake.errors).toEqual([]);
});

test("upgrade: values and a version from the chart's repository, a dry-run diff, then helm upgrade", async ({
  page,
}) => {
  const fake = await openApp(page);
  await page.getByRole("navigation").getByRole("button", { name: "Releases", exact: true }).click();
  await page.getByTestId("helm-row").filter({ hasText: "web" }).click();
  const detail = page.getByTestId("helm-detail");
  await expect(detail.getByTestId("helm-status")).toHaveText("deployed");
  await detail.getByRole("button", { name: "Upgrade…" }).click();

  const dlg = deployDialog(page);
  await expect(dlg.getByRole("heading")).toHaveText("Upgrade demo/web");
  expect(await fake.lastCall("cmdHelmChartVersions")).toEqual({ chart: "web" });
  // The release's version is preselected, and its own values prefilled.
  await expect(dlg.getByLabel("Chart version")).toHaveValue("1.2.0");
  await expect(dlg).toContainText("From example/web; the release runs web 1.2.0.");
  const values = dlg.getByRole("textbox", { name: "Values" });
  await expect(values).toContainText("greeting: bye");

  await dlg.getByLabel("Chart version").selectOption("1.3.0");
  await setText(page, values, "greeting: ciao\n");
  await dlg.getByTestId("deploy-preview").click();
  await expect(dlg.getByTestId("deploy-summary")).toContainText("Dry run of demo/web");
  const diff = dlg.getByRole("textbox", { name: "Manifest changes" });
  await expect(diff).toContainText('greeting: "ciao"');
  expect((await fake.lastCall("cmdHelmUpgrade")).request).toEqual({
    name: "web",
    namespace: "demo",
    chart: "example/web",
    version: "1.3.0",
    values: "greeting: ciao\n",
    create_namespace: false,
    dry_run: true,
    reveal: false,
  });
  // The current side of the diff is the newest revision, redacted the same way.
  expect(await fake.lastCall("cmdHelmGet")).toEqual({ namespace: "demo", name: "web", revision: 0, reveal: false });

  await dlg.getByTestId("deploy-confirm").click();
  await expect(dlg.getByTestId("deploy-result")).toHaveText("Upgraded demo/web to revision 3.");
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toBeHidden();
  // The open detail reloads: revision 3, the new chart version and values.
  await expect(detail).toContainText("web-1.3.0");
  await expect(detail.getByTestId("helm-notes")).toHaveText("web says ciao.");
  await expect(page.getByTestId("helm-row").filter({ hasText: "web" })).toContainText("3");
  expect(fake.errors).toEqual([]);
});

test("upgrading a release whose chart is in no configured repository says what to do", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation").getByRole("button", { name: "Releases", exact: true }).click();
  await page.getByTestId("helm-row").filter({ hasText: "metrics" }).click();
  await page.getByTestId("helm-detail").getByRole("button", { name: "Upgrade…" }).click();
  const dlg = deployDialog(page);
  await expect(dlg.getByTestId("deploy-sources-error")).toHaveText(
    "Chart metrics-server is not in any configured repository. Add the repository it came from (Helm → Charts, or Settings), then try again.",
  );
  await expect(dlg.getByTestId("deploy-preview")).toBeDisabled();
});

test("without helm, the Charts view says how to install it and Install is disabled", async ({ page }) => {
  await openApp(page, (c) => {
    c.helm.version = "";
  });
  await openCharts(page);
  await expect(page.getByTestId("helm-missing")).toContainText("helm is not installed or not on PATH");
  await chartRow(page, "example/web").click();
  await expect(chartDetail(page).getByRole("button", { name: "Install…" })).toBeDisabled();
});

test("the palette opens the Helm charts view", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.insertText("helm charts");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("helm-charts")).toBeVisible();
});
