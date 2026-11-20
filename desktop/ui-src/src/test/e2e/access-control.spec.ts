import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, row } from "./helpers";

const panel = (page: Page) => page.locator("aside");
const group = (page: Page, title: string) => panel(page).getByRole("region", { name: title, exact: true });
const title = (page: Page) => panel(page).locator(".title");

test("Access Control has the RBAC kinds, in Lens's order", async ({ page }) => {
  await openApp(page);
  const nav = page.getByRole("navigation");
  const labels = await nav.locator("h4, button:not(.section)").allTextContents();
  const start = labels.indexOf("Access Control");
  expect(labels.slice(start, start + 6)).toEqual([
    "Access Control",
    "Service Accounts",
    "Cluster Roles",
    "Roles",
    "Cluster Role Bindings",
    "Role Bindings",
  ]);
  // The other kinds Lens shows moved out of "Other".
  for (const label of ["Pod Disruption Budgets", "Priority Classes", "Leases", "Ingress Classes", "Definitions"]) {
    await expect(nav.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
});

test("a Role shows its rules and bindings; the binding links to its role and subjects", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Roles");
  expect(await column(page, "Rules")).toEqual(["2"]);
  await row(page, "pod-reader").click();
  await expect(title(page)).toHaveText("Role demo/pod-reader");
  await expect(panel(page).getByTestId("kind-summary")).toHaveText("2 rules");

  const rules = group(page, "Rules");
  await expect(rules.locator("thead th")).toHaveText(["API groups", "Resources", "Resource names", "Verbs"]);
  await expect(rules.locator("tbody tr").first().locator("td")).toHaveText(["core", "pods, pods/log", "all", "get, list"]);
  // Plain rows are not links.
  await expect(rules.getByRole("button")).toHaveCount(0);

  await group(page, "Role bindings").getByRole("button", { name: "web-reads-pods" }).click();
  await expect(title(page)).toHaveText("RoleBinding demo/web-reads-pods");
  await expect(group(page, "Users and groups")).toContainText("alice");

  // The subject opens the ServiceAccount, which lists its bindings and pods.
  await group(page, "Service accounts").getByRole("button", { name: "web" }).click();
  await expect(title(page)).toHaveText("ServiceAccount demo/web");
  await expect(group(page, "Pods")).toContainText("web-1");
  await expect(group(page, "Cluster role bindings").locator("h3")).toHaveText("Cluster role bindings (0)");

  // And back to the Role from its binding.
  await group(page, "Role bindings").getByRole("button", { name: "web-reads-pods" }).click();
  await group(page, "Role").getByRole("button", { name: "pod-reader" }).click();
  await expect(title(page)).toHaveText("Role demo/pod-reader");
  expect(fake.errors).toEqual([]);
});

test("a PodDisruptionBudget shows its disruption status and pods", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pod Disruption Budgets");
  expect(await column(page, "Allowed Disruptions")).toEqual(["1"]);
  expect(await column(page, "Max Unavailable")).toEqual(["N/A"]);
  await row(page, "web").click();
  await expect(panel(page).getByTestId("kind-summary")).toHaveText("1 disruption allowed · 2/1 healthy");
  await expect(group(page, "Pods").locator("tbody tr")).toHaveCount(2);
});

test("CRD definitions list their versions and open their instances", async ({ page }) => {
  const fake = await openApp(page);
  const nav = page.getByRole("navigation");
  // First under Custom Resources, not in an API group of its own.
  await expect(nav.locator("summary", { hasText: "apiextensions.k8s.io" })).toHaveCount(0);
  await openKind(page, "Definitions");
  expect(await column(page, "Kind")).toEqual(["Widget"]);
  expect(await column(page, "Scope")).toEqual(["Namespaced"]);
  await row(page, "widgets.example.com").click();
  await expect(title(page)).toHaveText("CustomResourceDefinition widgets.example.com");
  await expect(group(page, "Versions").locator("tbody td")).toHaveText(["v1", "yes", "yes", "no"]);

  await panel(page).getByRole("button", { name: "View instances" }).click();
  await expect(nav.getByRole("button", { name: "Widgets", exact: true })).toHaveClass(/active/);
  await expect(row(page, "gizmo")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("a CRD whose kind discovery does not serve has no instances button", async ({ page }) => {
  await openApp(page, (cluster) => {
    const id = "apiextensions.k8s.io/v1/customresourcedefinitions";
    const [crd] = cluster.rows[id];
    const name = "gadgets.example.org";
    cluster.rows[id] = [{ ...crd, key: name, name, cells: [name, ...crd.cells.slice(1)] }];
  });
  await openKind(page, "Definitions");
  await row(page, "gadgets.example.org").click();
  await expect(title(page)).toHaveText("CustomResourceDefinition gadgets.example.org");
  await expect(panel(page).getByRole("button", { name: "View instances" })).toHaveCount(0);
});
