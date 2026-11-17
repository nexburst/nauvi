import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { FakeCluster } from "../fixtures/cluster";
import type { FakeApi } from "../fake-backend";
import { openApp, openKind, row } from "./helpers";

// "Remove = hide" and cluster labels (ADR 0007, #333 PR 5): hiding takes a
// cluster out of the tree, the selector and the palette, in nauvi only;
// the catalog shows it again. Running things say which cluster they are on.

const node = (page: Page, id: string) => page.locator(`[data-testid="cluster-node"][data-cluster="${id}"]`);
const select = (page: Page, id: string) => node(page, id).getByRole("button", { name: id, exact: true });
const contextSelect = (page: Page) => page.getByRole("combobox", { name: "Cluster context" });
const dialog = (page: Page) => page.getByTestId("hide-dialog");
const catalogRow = (page: Page, id: string) => page.locator(`[data-testid="catalog-row"][data-context="${id}"]`);

/** A third context, and a colour for kind-dev. */
function threeClusters(cluster: FakeCluster, fake: FakeApi) {
  void fake;
  cluster.contexts.push({ name: "staging", current: false, namespace: null });
  cluster.settings.contexts["kind-dev"] = { view: "", namespaces: [], typed_namespaces: [], prometheus: "", display_name: "", color: "#ef4444", default_namespace: "", shell_cwd: "", last_used: 0, hide_metrics: false, mode: "normal", mode_source: { file: "", given: "", context: "" } };
}

/** The commands that could touch a kubeconfig file: none may run. */
const KUBECONFIG_WRITERS = ["cmdRemoveKubeconfigSource", "cmdAddKubeconfigSource", "cmdPasteKubeconfig"] as const;

test("hiding asks, says the kubeconfig is not changed, and the catalog unhides", async ({ page }) => {
  const fake = await openApp(page, threeClusters);
  await expect(node(page, "prod")).toBeVisible();
  // The cluster shown cannot be hidden from its own window.
  await node(page, "kind-dev").hover();
  await expect(node(page, "kind-dev").getByRole("button", { name: "Hide kind-dev" })).toHaveCount(0);

  await node(page, "prod").hover();
  await node(page, "prod").getByRole("button", { name: "Hide prod" }).click();
  await expect(dialog(page)).toContainText("only hidden in nauvi: your kubeconfig is not changed");
  await expect(page.getByTestId("hide-running")).toHaveCount(0);
  // Escape cancels.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(node(page, "prod")).toBeVisible();

  await node(page, "prod").hover();
  await node(page, "prod").getByRole("button", { name: "Hide prod" }).click();
  await dialog(page).getByRole("button", { name: "Hide prod" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(node(page, "prod")).toHaveCount(0);
  await expect(node(page, "staging")).toBeVisible();
  expect(await page.evaluate(() => window.__fake.cluster.settings.hidden_contexts)).toEqual(["prod"]);
  // Not in the context selector, nor in the palette.
  await expect(contextSelect(page).locator("option")).toHaveText(["kind-dev", "staging"]);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("prod");
  await expect(palette.getByRole("option", { name: /prod/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The catalog leaves it out until Show hidden; Unhide brings it back.
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await expect(catalogRow(page, "staging")).toBeVisible();
  await expect(catalogRow(page, "prod")).toHaveCount(0);
  await page.getByTestId("catalog-show-hidden").check();
  await expect(catalogRow(page, "prod").getByTestId("catalog-hidden")).toBeVisible();
  await catalogRow(page, "prod").getByRole("button", { name: "Unhide prod" }).click();
  await expect(catalogRow(page, "prod").getByTestId("catalog-hidden")).toHaveCount(0);
  await expect(node(page, "prod")).toBeVisible();
  expect(await page.evaluate(() => window.__fake.cluster.settings.hidden_contexts)).toEqual([]);

  // Hide from the catalog's row menu too; the shown one's entry is disabled.
  await catalogRow(page, "kind-dev").getByRole("button", { name: "More actions for kind-dev" }).click();
  await expect(page.getByRole("menuitem", { name: "Hide… (shown here)" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await catalogRow(page, "staging").getByRole("button", { name: "More actions for staging" }).click();
  await page.getByRole("menuitem", { name: "Hide…" }).click();
  await dialog(page).getByRole("button", { name: "Hide staging" }).click();
  await expect(node(page, "staging")).toHaveCount(0);
  await expect(page.getByTestId("catalog-show-hidden")).toBeChecked();
  await expect(catalogRow(page, "staging").getByTestId("catalog-hidden")).toBeVisible();

  for (const cmd of KUBECONFIG_WRITERS) expect(await fake.calls(cmd)).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("every cluster hidden but the shown one: the catalog says how to list them", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.hidden_contexts = ["kind-dev", "prod"];
  });
  // The shown one stays in the tree and the selector, marked hidden.
  await expect(node(page, "kind-dev")).toContainText("hidden");
  await expect(node(page, "prod")).toHaveCount(0);
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await expect(page.getByTestId("catalog-all-hidden")).toBeVisible();
  await expect(page.getByText("Show hidden (2)")).toBeVisible();
});

test("hiding a cluster with forwards and tabs running asks first and stops them", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.backgroundForwards = [
      {
        cluster: "kind-dev",
        forward: {
          id: "pf-bg",
          saved_id: "fwd-bg",
          target: { kind: "service", namespace: "demo", name: "web" },
          remote: "80",
          remote_port: 80,
          local_port: 40080,
          url: "http://127.0.0.1:40080",
          started_at: 1,
          status: { pod: "web-1", connections: 0, total_connections: 2, last_error: "" },
        },
      },
    ];
    cluster.settings.contexts["kind-dev"] = { view: "", namespaces: [], typed_namespaces: [], prometheus: "", display_name: "", color: "#ef4444", default_namespace: "", shell_cwd: "", last_used: 0, hide_metrics: false, mode: "normal", mode_source: { file: "", given: "", context: "" } };
  });
  // A log tab on kind-dev, then show prod: kind-dev runs on in the background.
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Logs" }).click();
  await expect(page.getByTestId("dock").getByRole("tab", { name: "Logs: web-1" })).toBeVisible();
  await select(page, "prod").click();
  await expect(node(page, "prod")).toHaveAttribute("data-state", "visible");

  // The dock tab, the status bar and Port Forwards name kind-dev, in its colour.
  const tabLabel = page.getByTestId("dock-tab-cluster");
  await expect(tabLabel).toHaveText("kind-dev");
  await expect(tabLabel.getByTestId("cluster-label-color")).toHaveCSS("background-color", "rgb(239, 68, 68)");
  await expect(page.getByTestId("status-cluster")).toHaveText("prod");
  const bg = page.locator('[data-testid="status-background-cluster"][data-cluster="kind-dev"]');
  await expect(bg).toContainText("kind-dev");
  await expect(bg).toContainText("1 forward · 1 tab");
  await expect(bg.getByTestId("cluster-label-color")).toBeVisible();
  await openKind(page, "Port Forwards");
  const other = page.locator('[data-testid="forward-row-other"][data-cluster="kind-dev"]');
  await expect(other).toContainText("http://127.0.0.1:40080");
  await expect(other.getByTestId("forward-cluster")).toHaveText("kind-dev");

  // Hiding it asks first, and says what stops.
  await node(page, "kind-dev").hover();
  await node(page, "kind-dev").getByRole("button", { name: "Hide kind-dev" }).click();
  await expect(page.getByTestId("hide-running")).toContainText("1 port-forward and 1 dock tab run on it");
  await expect(page.getByTestId("hide-running")).toContainText("they stop");
  await dialog(page).getByRole("button", { name: "Stop and hide kind-dev" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => fake.calls("cmdClusterDisconnect")).toHaveLength(1);
  await expect(page.getByTestId("dock")).toHaveCount(0);
  await expect(node(page, "kind-dev")).toHaveCount(0);
  await expect(other).toHaveCount(0);
  await expect(page.getByTestId("status-background")).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("notifications name their cluster with its label", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.contexts["kind-dev"] = { view: "", namespaces: [], typed_namespaces: [], prometheus: "", display_name: "Dev box", color: "#3b82f6", default_namespace: "", shell_cwd: "", last_used: 0, hide_metrics: false, mode: "normal", mode_source: { file: "", given: "", context: "" } };
  });
  await node(page, "prod").hover();
  await node(page, "prod").getByRole("button", { name: "Hide prod" }).click();
  await dialog(page).getByRole("button", { name: "Hide prod" }).click();
  await page.getByTestId("notification-bell").click();
  const item = page.getByTestId("notification").first();
  await expect(item).toContainText("Hid prod in nauvi");
  await expect(item.getByTestId("cluster-label")).toHaveText("Dev box");
  await expect(item.getByTestId("cluster-label-color")).toBeVisible();
});
