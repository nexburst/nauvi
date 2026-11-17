import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { FakeCluster } from "../fixtures/cluster";
import type { FakeApi } from "../fake-backend";
import { openApp, openKind, row } from "./helpers";

// The cluster tree (ADR 0007, #333): every context in the sidebar, grouped
// by source; a node connects only when expanded or selected, a login command
// of an added kubeconfig asks inside its node, and switching A -> B -> A
// shows nothing of the other cluster.

const nav = (page: Page) => page.getByRole("navigation");
const node = (page: Page, id: string) => page.locator(`[data-testid="cluster-node"][data-cluster="${id}"]`);
const expand = (page: Page, id: string) => node(page, id).getByRole("button", { name: `Expand ${id}`, exact: true });
const select = (page: Page, id: string) => node(page, id).getByRole("button", { name: id, exact: true });
const clusterCalls = (page: Page) => page.evaluate(() => window.__fake.clusterCalls());
/** The clusters named by `cmd` so far. */
const clustersOf = async (page: Page, cmd: string) =>
  (await clusterCalls(page)).filter(([c]) => c === cmd).map(([, cluster]) => cluster);

/**
 * Three clusters: kind-dev (shown), prod (another default-kubeconfig context,
 * serving other pods, namespaces and a CRD) and staging, from an added
 * kubeconfig whose login runs a plugin.
 */
function threeClusters(cluster: FakeCluster, fake: FakeApi) {
  void fake;
  cluster.contexts.push({
    name: "staging",
    current: false,
    namespace: null,
    source: "/home/user/work/team.yaml",
    file: "/home/user/work/team.yaml",
    login_plugin: true,
    login_command: "kubelogin get-token --server-id staging",
  });
  const web = cluster.rows["v1/pods"].find((r) => r.name === "web-1")!;
  const swap = (v: string) => (v === "web-1" ? "prod-api-1" : v === "demo" ? "payments" : v);
  const prodPod = { ...web, key: "payments/prod-api-1", name: "prod-api-1", namespace: "payments", cells: web.cells.map(swap) };
  const crd = {
    ...cluster.kinds.find((k) => k.id === "v1/pods")!,
    id: "example.org/v1/gadgets",
    label: "Gadgets",
    category: "custom" as const,
    resource: { group: "example.org", version: "v1", kind: "Gadget", plural: "gadgets", namespaced: true },
  };
  cluster.byCluster = {
    prod: {
      kinds: [...cluster.kinds, crd],
      namespaces: [{ name: "payments", status: "Active", created: 0, age: "1d" }],
      rows: { "v1/pods": [prodPod], "example.org/v1/gadgets": [] },
    },
  };
}

test("the tree lists every context by source and asks no other cluster anything before a click", async ({ page }) => {
  const fake = await openApp(page, threeClusters);
  await expect(node(page, "kind-dev")).toHaveAttribute("data-state", "visible");
  await expect(nav(page).getByRole("button", { name: "Kubeconfig" })).toBeVisible();
  await expect(nav(page).getByRole("button", { name: "team.yaml" })).toBeVisible();
  await expect(node(page, "prod")).toHaveAttribute("data-state", "idle");
  await expect(node(page, "staging")).toHaveAttribute("data-state", "idle");

  // Idle for a while, and hovering, ask nothing of prod or staging.
  await node(page, "prod").hover();
  await node(page, "staging").hover();
  await page.waitForTimeout(500);
  const named = new Set((await clusterCalls(page)).map(([, c]) => c));
  expect([...named].filter((c) => c !== "kind-dev" && c !== "")).toEqual([]);
  expect(await fake.calls("cmdClusterConnect")).toEqual([]);
  expect(await fake.calls("cmdCheckContext")).toEqual([]);
  expect(await fake.calls("cmdExecCommands")).toEqual([]);
  expect(await page.evaluate(() => window.__fake.cluster.catalog.pluginRuns)).toEqual({});

  // Expanding connects that one, in the background, and lists its kinds.
  await expand(page, "prod").click();
  await expect(node(page, "prod")).toHaveAttribute("data-state", "connected");
  expect(await clustersOf(page, "cmdClusterConnect")).toEqual(["prod"]);
  expect(await clustersOf(page, "cmdDiscover")).toContain("prod");
  expect(await page.evaluate(() => window.__fake.connected())).toEqual(["prod"]);
  // Its resource groups come from its own kinds: the CRD only prod serves.
  await node(page, "prod").getByText("Custom Resources").click();
  await expect(node(page, "prod").getByRole("button", { name: "Gadgets" })).toBeVisible();
  await expect(node(page, "kind-dev").getByRole("button", { name: "Gadgets", includeHidden: true })).toHaveCount(0);
  // Still shown: kind-dev, its watches the only ones.
  expect(await clustersOf(page, "cmdSetContext")).toEqual([]);
  const feeds = (await clusterCalls(page)).filter(([c]) => c.startsWith("cmdWatch") || c.startsWith("cmdOverview"));
  expect(feeds.length).toBeGreaterThan(0);
  expect(new Set(feeds.map(([, t]) => t))).toEqual(new Set(["kind-dev"]));
  expect(fake.errors).toEqual([]);
});

test("selecting a node shows that cluster; the one shown before stays connected", async ({ page }) => {
  const fake = await openApp(page, threeClusters);
  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();

  await select(page, "prod").click();
  await expect(node(page, "prod")).toHaveAttribute("data-state", "visible");
  await expect(select(page, "prod")).toHaveAttribute("aria-current", "true");
  await expect(node(page, "kind-dev")).toHaveAttribute("data-state", "connected");
  expect((await fake.calls("cmdSetContext")).map((c) => c.name)).toEqual(["prod"]);
  // The shown cluster's groups are inside its node; watches run for it only.
  await node(page, "prod").getByRole("button", { name: "Pods", exact: true }).click();
  await expect(row(page, "prod-api-1")).toBeVisible();
  const after = (await clusterCalls(page)).slice((await clusterCalls(page)).findIndex(([c]) => c === "cmdSetContext") + 1);
  expect(new Set(after.filter(([c]) => c === "cmdWatchStart").map(([, t]) => t))).toEqual(new Set(["prod"]));
  // No Disconnect for the shown one; the background one has it.
  await expect(node(page, "prod").getByRole("button", { name: "Disconnect prod" })).toHaveCount(0);
  await node(page, "kind-dev").hover();
  await node(page, "kind-dev").getByRole("button", { name: "Disconnect kind-dev" }).click();
  await expect(node(page, "kind-dev")).toHaveAttribute("data-state", "idle");
  expect(await clustersOf(page, "cmdClusterDisconnect")).toEqual(["kind-dev"]);
  // Shown again, it opens with its resource groups.
  await select(page, "kind-dev").click();
  await expect(node(page, "kind-dev")).toHaveAttribute("data-state", "visible");
  await expect(node(page, "kind-dev").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("a kind in a background node opens it on that cluster", async ({ page }) => {
  await openApp(page, threeClusters);
  await expand(page, "prod").click();
  await node(page, "prod").getByText("Workloads").click();
  await node(page, "prod").getByRole("button", { name: "Pods", exact: true }).click();
  await expect(node(page, "prod")).toHaveAttribute("data-state", "visible");
  await expect(row(page, "prod-api-1")).toBeVisible();
  await expect(row(page, "web-1")).toHaveCount(0);
});

test("switching A -> B -> A shows nothing of the other cluster", async ({ page }) => {
  const fake = await openApp(page, threeClusters);
  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();
  const namespaces = async () => {
    await page.getByRole("button", { name: "Namespace", exact: true }).click();
    const list = await page.getByRole("group", { name: "Namespace list" }).innerText();
    await page.keyboard.press("Escape");
    return list;
  };
  expect(await namespaces()).toContain("demo");

  // B: only prod's pods, namespaces and kinds.
  await select(page, "prod").click();
  await expect(node(page, "prod")).toHaveAttribute("data-state", "visible");
  await openKind(page, "Pods");
  await expect(row(page, "prod-api-1")).toBeVisible();
  await expect(row(page, "web-1")).toHaveCount(0);
  await expect(row(page, "db-0")).toHaveCount(0);
  const onB = await namespaces();
  expect(onB).toContain("payments");
  expect(onB).not.toContain("demo");
  // Its CRD is in its node (under Custom Resources, closed).
  await expect(node(page, "prod").getByRole("button", { name: "Gadgets", includeHidden: true })).toHaveCount(1);

  // Back on A: only kind-dev's again, nothing of prod.
  await select(page, "kind-dev").click();
  await expect(node(page, "kind-dev")).toHaveAttribute("data-state", "visible");
  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();
  await expect(row(page, "prod-api-1")).toHaveCount(0);
  const onA = await namespaces();
  expect(onA).toContain("demo");
  expect(onA).not.toContain("payments");
  await expect(node(page, "kind-dev").getByRole("button", { name: "Gadgets", includeHidden: true })).toHaveCount(0);
  // The problem badges are kind-dev's (crashed, db-0), and the history starts over.
  await expect(page.getByRole("button", { name: "Go back" })).toBeDisabled();
  expect((await fake.calls("cmdSetContext")).map((c) => c.name)).toEqual(["prod", "kind-dev"]);
  expect(fake.errors).toEqual([]);
});

test("an added kubeconfig's login command asks inside its node and runs only once allowed", async ({ page }) => {
  const fake = await openApp(page, threeClusters);
  await expand(page, "staging").click();
  const prompt = node(page, "staging").getByRole("alertdialog", { name: "Allow login command" });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByTestId("exec-command")).toHaveText("kubelogin get-token --server-id staging");
  await expect(node(page, "staging")).toHaveAttribute("data-state", "consent");
  expect(await fake.calls("cmdClusterConnect")).toEqual([]);
  expect(await page.evaluate(() => window.__fake.cluster.catalog.pluginRuns)).toEqual({});

  // Don't run: remembered, nothing ran, the node says why.
  await prompt.getByRole("button", { name: "Don't run" }).click();
  expect(await fake.lastCall("cmdAnswerExecCommand")).toMatchObject({ allow: false });
  await expect(node(page, "staging")).toHaveAttribute("data-state", "failed");
  expect(await fake.calls("cmdClusterConnect")).toEqual([]);

  // Selecting it asks again; Allow connects and shows it.
  await select(page, "staging").click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Allow and connect" }).click();
  expect(await fake.lastCall("cmdAnswerExecCommand")).toMatchObject({ allow: true });
  await expect(node(page, "staging")).toHaveAttribute("data-state", "visible");
  expect(await clustersOf(page, "cmdClusterConnect")).toEqual(["staging"]);
  expect(await page.evaluate(() => window.__fake.cluster.catalog.pluginRuns)).toEqual({ staging: 1 });
  expect((await fake.calls("cmdSetContext")).map((c) => c.name)).toEqual(["staging"]);
  expect(fake.errors).toEqual([]);
});

test("a log stream keeps running on its cluster after a switch, labelled with it", async ({ page }) => {
  const fake = await openApp(page, threeClusters);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Logs" }).click();
  const tab = page.getByTestId("dock").getByRole("tab", { name: "Logs: web-1" });
  await expect(tab).toBeVisible();
  await expect.poll(() => fake.activeLogStreams()).toHaveLength(1);
  // One cluster, the one shown: no label yet.
  await expect(page.getByTestId("dock-tab-cluster")).toHaveCount(0);

  await select(page, "prod").click();
  await expect(node(page, "prod")).toHaveAttribute("data-state", "visible");
  await expect(tab).toBeVisible();
  await expect(page.getByTestId("dock-tab-cluster")).toHaveText("kind-dev");
  expect(await fake.calls("cmdStopLogs")).toEqual([]);
  expect(await fake.activeLogStreams()).toHaveLength(1);
  expect(await clustersOf(page, "cmdStreamPodLogs")).toEqual(["kind-dev"]);
  await expect(page.locator('[data-testid="dock-pane"][data-tab="logs:demo/web-1"]')).toHaveAttribute(
    "data-cluster",
    "kind-dev",
  );

  // Disconnecting kind-dev ends its stream and closes its tab.
  await node(page, "kind-dev").hover();
  await node(page, "kind-dev").getByRole("button", { name: "Disconnect kind-dev" }).click();
  await expect(tab).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("open in new window still opens a window for the cluster", async ({ page }) => {
  const fake = await openApp(page, threeClusters);
  await node(page, "prod").hover();
  await node(page, "prod").getByRole("button", { name: "Open prod in new window" }).click();
  await expect.poll(() => fake.calls("cmdOpenWindow")).toEqual([{ context: "prod" }]);
  // It asks prod nothing in this window.
  expect(await fake.calls("cmdClusterConnect")).toEqual([]);
});
