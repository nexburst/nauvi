import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// The detail panel's sticky header of action icons (#218).

const panel = (page: Page) => page.getByTestId("detail-panel");
const bar = (page: Page) => panel(page).getByRole("toolbar", { name: "Actions" });
const button = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const tip = (page: Page) => page.getByTestId("action-tip");
const tabs = (page: Page) => page.getByTestId("dock").getByRole("tab");
const dialog = (page: Page) => page.getByRole("alertdialog");

test("the pod header has Logs, Shell, Attach, Edit and Delete, and no Logs and shell block", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(bar(page).getByRole("button")).toHaveText([
    "Logs",
    "Shell",
    "Port forward…",
    "Attach",
    "Debug…",
    "Edit",
    "Evict",
    "Delete",
    "Force delete…",
  ]);
  await expect(panel(page).getByText("Logs and shell")).toHaveCount(0);
  // Every item has an icon.
  await expect(bar(page).locator("button svg")).toHaveCount(9);
  // One access check for all of them.
  await expect.poll(() => fake.calls("cmdCheckActions")).toHaveLength(1);
  expect((await fake.lastCall("cmdCheckActions")).ids).toEqual([
    "logs",
    "shell",
    "portForward",
    "attach",
    "debug",
    "edit",
    "evict",
    "delete",
    "forceDelete",
  ]);

  // Shell opens a terminal in the dock; Logs the pod's logs.
  await expect(panel(page).locator("h3", { hasText: "Containers" })).toBeVisible();
  await button(page, "Shell").click();
  await button(page, "Logs").click();
  await expect(tabs(page)).toHaveText(["Shell: web-1", "Logs: web-1"]);
});

test("a deployment has Logs, Scale and Restart; a node Shell, Cordon and Drain", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click();
  await expect(bar(page).getByRole("button")).toHaveText(["Logs", "Scale…", "Rollout restart", "Port forward…", "Edit", "Delete"]);
  await button(page, "Scale…").click();
  await expect(dialog(page)).toHaveAccessibleName("Scale Deployment");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();

  await openKind(page, "Nodes");
  await row(page, "node-1").click();
  await expect(bar(page).getByRole("button")).toHaveText(["Shell", "Cordon", "Uncordon", "Edit", "Drain…", "Delete"]);
});

test("Edit opens the YAML tab of a generic panel", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click();
  await button(page, "Edit").click();
  await expect(panel(page).getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByTestId("yaml-editor")).toBeVisible();
});

test("Edit brings the pod's YAML editor into view", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator("h3", { hasText: "Containers" })).toBeVisible();
  const editor = panel(page).getByTestId("yaml-editor");
  await expect(editor).toBeAttached();
  await button(page, "Edit").click();
  await expect(editor).toBeInViewport();
  // The header stays at the top of the scrolled panel.
  await expect(bar(page)).toBeInViewport();
  const [panelTop, barTop] = await Promise.all([
    panel(page).evaluate((e) => e.getBoundingClientRect().top),
    bar(page).evaluate((e) => e.getBoundingClientRect().top),
  ]);
  expect(barTop - panelTop).toBeLessThan(60);
  expect(await panel(page).evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
});

test("tooltips name the action, on hover and on keyboard focus", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await button(page, "Port forward…").hover();
  await expect(tip(page)).toHaveText("Port forward");
  await page.mouse.move(0, 0);
  await expect(tip(page)).toHaveCount(0);

  // Focus, then the arrow keys move along the bar and Enter runs the action.
  await button(page, "Logs").focus();
  await expect(tip(page)).toHaveText("Logs");
  await page.keyboard.press("ArrowRight");
  await expect(button(page, "Shell")).toBeFocused();
  await expect(tip(page)).toHaveText("Shell");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(button(page, "Force delete…")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveAccessibleName("Force delete Pod");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // The tooltip of the last button stays inside the panel.
  await button(page, "Force delete…").hover();
  const [p, t] = await Promise.all([
    panel(page).evaluate((e) => e.getBoundingClientRect().right),
    tip(page).evaluate((e) => e.getBoundingClientRect().right),
  ]);
  expect(t).toBeLessThanOrEqual(p);
});

test("actions RBAC refuses are greyed, say why, and do nothing", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.deniedActions = {
      shell: "Not allowed: you can't create pods/exec in namespace demo",
      delete: "Not allowed: you can't delete pods in namespace demo",
    };
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(button(page, "Shell")).toHaveAttribute("aria-disabled", "true");
  await expect(button(page, "Delete")).toHaveAttribute("aria-disabled", "true");
  await expect(button(page, "Logs")).not.toHaveAttribute("aria-disabled");
  await expect(button(page, "Shell")).toHaveAccessibleDescription(
    "Not allowed: you can't create pods/exec in namespace demo",
  );

  await button(page, "Shell").hover();
  await expect(tip(page)).toHaveText(/^Shell\s*Not allowed: you can't create pods\/exec in namespace demo$/);
  await button(page, "Shell").click({ force: true });
  await button(page, "Delete").click({ force: true });
  await expect(tabs(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdRunAction")).toEqual([]);

  // Logs still works.
  await button(page, "Logs").click();
  await expect(tabs(page)).toHaveText(["Logs: web-1"]);
});

test("a failed access check offers every action", async ({ page }) => {
  await openApp(page, (_cluster, fake) => fake.failNext("cmdCheckActions", "the API server is down"));
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(bar(page).getByRole("button")).toHaveCount(9);
  for (const b of await bar(page).getByRole("button").all()) await expect(b).not.toHaveAttribute("aria-disabled");
});
