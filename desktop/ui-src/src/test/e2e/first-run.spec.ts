// The first run and the empty states (#485): the welcome screen with and
// without a kubeconfig, the tips strip, and why a table is empty.
import { expect, test } from "@playwright/test";
import { openApp, openKind, rows, toggleNamespaces } from "./helpers";

const welcome = (page: import("@playwright/test").Page) => page.getByTestId("welcome");
const empty = (page: import("@playwright/test").Page) => page.getByTestId("empty-state");

test("a first run opens on the welcome screen: what was found, the clusters, three next steps", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.welcomed = false;
    cluster.settings.tips_left = 5;
  });
  await expect(welcome(page)).toBeVisible();
  await expect(welcome(page).getByRole("heading", { level: 2 })).toHaveText("Pick a cluster to start");
  const looked = page.getByTestId("welcome-looked");
  await expect(looked).toContainText("/home/user/.kube/config");
  await expect(looked).toContainText("2 contexts");
  const clusters = page.getByTestId("welcome-clusters").getByRole("button");
  await expect(clusters).toHaveCount(2);
  await expect(clusters.first()).toContainText("current");
  await expect(welcome(page).locator(".step")).toHaveText([/Find a pod.*Ctrl\+K/, /Read its logs.*l/, /Open a shell.*s/]);
  // No tips strip on the welcome screen itself; no toolbar either.
  await expect(page.getByTestId("tips-strip")).toHaveCount(0);
  // The tips count down once per start.
  await expect.poll(async () => (await fake.calls("cmdUpdateSettings")).map((c) => c.patch)).toContainEqual({ tips_left: 4 });

  await page.getByRole("button", { name: "Getting started in the docs" }).click();
  expect((await fake.lastCall("cmdHelpOpen")).item).toBe("get_started");

  // Picking the current cluster opens its Overview, and the welcome is remembered.
  await clusters.first().click();
  await expect(welcome(page)).toHaveCount(0);
  await expect(page.getByText("Pods need attention").or(page.locator(".card").first())).toBeVisible();
  await expect.poll(async () => (await fake.calls("cmdUpdateSettings")).map((c) => c.patch)).toContainEqual({ welcomed: true });

  // The tips strip, closed for good.
  const strip = page.getByTestId("tips-strip");
  await expect(strip).toContainText("every kind");
  await expect(strip).toContainText("Ctrl+K");
  await strip.getByRole("button", { name: "Hide the tips" }).click();
  await expect(strip).toHaveCount(0);
  expect((await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ tips_left: 0 });
  expect(fake.errors).toEqual([]);
});

test("picking another cluster on the welcome screen switches to it", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.welcomed = false;
  });
  await page.getByTestId("welcome-clusters").getByRole("button").nth(1).click();
  await expect(welcome(page)).toHaveCount(0);
  const name = (await fake.lastCall("cmdSetContext")).name;
  expect(name).toBeTruthy();
});

test("a later start, or a settings file from before, opens where it ended", async ({ page }) => {
  await openApp(page);
  await expect(welcome(page)).toHaveCount(0);
  await expect(page.getByTestId("tips-strip")).toHaveCount(0);
});

test("with no kubeconfig, the welcome says where nauvi looked and how to add one", async ({ page }) => {
  const fake = await openApp(
    page,
    (cluster, fake) => {
      cluster.contexts = [];
      cluster.catalog.sources = [
        { path: "/home/user/.kube/config", kind: "kubeconfig", contexts: 0, files: 0, error: "the file does not exist" },
      ];
      fake.failNext("cmdDiscover", "No kubeconfig found (looked at /home/user/.kube/config; KUBECONFIG is not set).");
    },
    { waitForKinds: false },
  );
  await expect(welcome(page).getByRole("heading", { level: 2 })).toHaveText("No kubeconfig found");
  await expect(page.getByTestId("welcome-looked")).toContainText("/home/user/.kube/config");
  await expect(page.getByTestId("welcome-looked")).toContainText("the file does not exist");
  await expect(page.locator("header")).toContainText("No kubeconfig");
  // Said once, on the welcome screen, not in a banner too.
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(welcome(page).getByRole("button", { name: "Skip to the Overview" })).toHaveCount(0);

  // Adding a file brings its contexts in, to pick from.
  await page.evaluate(() => {
    window.__fake.cluster.catalog.files["/home/user/work.yaml"] = [{ name: "work", current: false, namespace: null }];
  });
  await welcome(page).getByLabel("Kubeconfig file or folder").fill("/home/user/work.yaml");
  await welcome(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("welcome-clusters").getByRole("button")).toHaveCount(1);
  await expect(welcome(page).getByRole("heading", { level: 2 })).toHaveText("Pick a cluster to start");
  expect(fake.errors).toEqual([]);
});

test("a kubeconfig that cannot be read says so and keeps its error, instead of 'No kubeconfig found'", async ({ page }) => {
  const BAD = "Cannot use the kubeconfig: /home/user/.kube/config: did not find expected key at line 3 column 1";
  await openApp(
    page,
    (cluster, fake) => {
      cluster.contexts = [];
      cluster.catalog.sources = [
        {
          path: "/home/user/.kube/config",
          kind: "kubeconfig",
          contexts: 0,
          files: 0,
          error: "did not find expected key at line 3 column 1 while parsing a block mapping that started at line 1 column 1",
        },
      ];
      fake.failNext("cmdDiscover", "Cannot use the kubeconfig: /home/user/.kube/config: did not find expected key at line 3 column 1");
    },
    { waitForKinds: false },
  );
  await expect(welcome(page).getByRole("heading", { level: 2 })).toHaveText("nauvi could not read your kubeconfig");
  await expect(page.getByTestId("welcome-looked")).toContainText("did not find expected key at line 3 column 1");
  await expect(welcome(page)).not.toContainText("No kubeconfig found");
  await expect(page.locator("header").first()).toContainText("Kubeconfig error");
  await expect(page.locator("header").first()).not.toContainText("Connecting");
  // The real error stays in the banner.
  await expect(page.getByRole("alert")).toContainText(BAD);
  // A long error wraps inside the card.
  const fits = await page.getByTestId("welcome-looked").evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
});

test("a filter carried over from another kind says so, and Clear filter brings the rows back", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await page.getByRole("searchbox", { name: "Filter" }).fill("crashed");
  await expect(rows(page)).toHaveCount(1);
  await openKind(page, "Deployments");
  await expect(rows(page)).toHaveCount(0);
  await expect(empty(page)).toContainText('No Deployments match "crashed"');
  await expect(empty(page)).toContainText("The filter hides all");
  await empty(page).getByRole("button", { name: "Clear filter" }).click();
  await expect(rows(page)).not.toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Filter" })).toHaveValue("");
});

test("an empty namespace offers all namespaces and Create", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.rows["apps/v1/deployments"] = [];
  });
  await openKind(page, "Deployments");
  await toggleNamespaces(page, "demo");
  await expect(empty(page)).toContainText("No Deployments in namespace demo");
  await expect(empty(page).getByRole("button", { name: "Create…" })).toBeVisible();
  await empty(page).getByRole("button", { name: "All namespaces" }).click();
  await expect(empty(page)).toContainText("No Deployments in any namespace");
  await empty(page).getByRole("button", { name: "Create…" }).click();
  await expect(page.getByRole("dialog")).toContainText("Deployment");
});

test("a kind the user may not list says which verb and resource", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.deniedClusterWide = ["v1/pods"];
  });
  await openKind(page, "Pods");
  await expect(empty(page)).toHaveAttribute("data-reason", "denied");
  await expect(empty(page)).toContainText("No access to Pods across all namespaces");
  await expect(empty(page)).toContainText('may not "list" pods across all namespaces');
});

test("without a metrics API, the Pods table says why CPU and memory are empty", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.metrics.available = false;
    cluster.metrics.pods = [];
  });
  await openKind(page, "Pods");
  await expect(page.getByTestId("metrics-missing")).toContainText("no metrics API (metrics-server)");
  await expect(page.getByTestId("metrics-missing").getByRole("button", { name: "Install metrics-server…" })).toBeVisible();
});
