import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// The line at the top of a dock tab (#386): what the tab is attached to,
// with links that open the pod (or workload) and the namespace; and the
// banner after a port-forward starts, with Open and Port Forwards.

const panel = (page: Page) => page.getByTestId("detail-panel");
const dock = (page: Page) => page.getByTestId("dock");
const pane = (page: Page, tabId: string) => dock(page).locator(`[data-testid="dock-pane"][data-tab="${tabId}"]`);
const contextOf = (page: Page, tabId: string) => pane(page, tabId).getByTestId("dock-context");
const notice = (page: Page) => page.getByTestId("action-notice");

test("pod logs name the pod, container, namespace and since; the names open the objects", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator("h3", { hasText: "Containers" })).toBeVisible();
  await panel(page).getByRole("button", { name: "Logs", exact: true }).click();

  const line = contextOf(page, "logs:demo/web-1");
  await expect(line).toHaveText("Logs of pod web-1 in namespace demo, container app, from all time");
  // It follows the log options.
  await pane(page, "logs:demo/web-1").getByTitle("Since", { exact: true }).selectOption("300");
  await expect(line).toHaveText("Logs of pod web-1 in namespace demo, container app, from the last 5m");

  // With the panel closed, the pod name opens it again.
  await panel(page).getByRole("button", { name: "Close details" }).click();
  await expect(panel(page)).toHaveCount(0);
  await line.getByRole("button", { name: "web-1", exact: true }).click();
  await expect(page.locator("aside .title")).toHaveText("demo/web-1");

  // The namespace opens the Namespace.
  await line.getByRole("button", { name: "demo", exact: true }).click();
  await expect(page.locator("aside .title")).toHaveText(/Namespace\s*demo/);
});

test("workload logs name the workload, which opens it", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click();
  await panel(page).getByRole("button", { name: "Logs", exact: true }).click();
  const line = contextOf(page, "wlogs:Deployment:demo/web");
  await expect(line).toHaveText("Logs of deployment web in namespace demo, all pods, all containers, from all time");
  await panel(page).getByRole("button", { name: "Close details" }).click();
  await openKind(page, "Pods");
  await line.getByRole("button", { name: "web", exact: true }).click();
  await expect(page.locator("aside .title")).toHaveText("Deployment demo/web");
  await expect(row(page, "web")).toBeVisible();
});

test("a shell names its pod, container and namespace", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Shell" }).click();
  await expect.poll(() => fake.calls("cmdExecStart")).toHaveLength(1);
  const line = contextOf(page, "shell:demo/web-1");
  await expect(line).toHaveText("Shell into pod web-1, container app, in namespace demo");
  await expect(line.getByRole("button", { name: "web-1", exact: true })).toBeEnabled();
  await expect(line.getByRole("button", { name: "demo", exact: true })).toBeEnabled();
});

test("a forward from the pod panel shows a banner whose Port Forwards opens the view", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await page.locator("aside").getByLabel("Pod port").fill("8080");
  await page.locator("aside").getByLabel("Local port").fill("18080");
  await page.locator("aside").getByRole("button", { name: "Forward", exact: true }).click();

  await expect(notice(page)).toContainText("Forwarding http://127.0.0.1:18080 → pod/demo/web-1:8080");
  // It is kept in the notification history too.
  await expect(page.getByRole("button", { name: /^Notifications/ })).toContainText("1");
  await notice(page).getByRole("button", { name: "Port Forwards", exact: true }).click();
  await expect(page.getByTestId("port-forwards")).toBeVisible();
  await expect(page.getByTestId("forward-row")).toContainText("pod/demo/web-1");
});

test("a forward from a Service's ports shows a banner whose Open opens the browser", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Services");
  await row(page, "api").click();
  await page.locator("aside").getByTestId("service-ports").getByRole("button", { name: "Forward port 9090" }).click();
  await expect(notice(page)).toContainText("Forwarding http://127.0.0.1:9090 → svc/demo/api:9090");
  await notice(page).getByRole("button", { name: "Open", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual(["http://127.0.0.1:9090"]);
  await notice(page).getByRole("button", { name: "Port Forwards", exact: true }).click();
  await expect(page.getByTestId("port-forwards")).toBeVisible();
});

test("on another cluster than the one shown, the line names its cluster and the links wait", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Logs" }).click();
  const line = contextOf(page, "logs:demo/web-1");
  await expect(line.getByTestId("cluster-label")).toHaveCount(0);
  await expect(line.getByRole("button", { name: "web-1", exact: true })).toBeEnabled();

  const prod = page.locator('[data-testid="cluster-node"][data-cluster="prod"]');
  await prod.getByRole("button", { name: "prod", exact: true }).click();
  await expect(prod).toHaveAttribute("data-state", "visible");
  await expect(line).toContainText("on kind-dev");
  await expect(line.getByTestId("cluster-label")).toHaveText("kind-dev");
  await expect(line.getByRole("button", { name: "web-1", exact: true })).toBeDisabled();
  await expect(line.getByRole("button", { name: "demo", exact: true })).toBeDisabled();
});
