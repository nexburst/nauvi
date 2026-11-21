// Collapsible sidebar sections and short labels for long context names (#383).

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind } from "./helpers";

const kinds = (page: Page) => page.getByTestId("sidebar-kinds");
const sectionToggle = (page: Page, title: string) =>
  kinds(page).getByRole("heading", { name: title, exact: true }).getByRole("button");

test("sections collapse and expand, by click or keyboard, and stay so after a restart", async ({ page }) => {
  const fake = await openApp(page);
  const network = sectionToggle(page, "Network");
  await expect(network).toHaveAttribute("aria-expanded", "true");
  await expect(kinds(page).getByRole("button", { name: "Services", exact: true })).toBeVisible();

  await network.click();
  await expect(network).toHaveAttribute("aria-expanded", "false");
  await expect(kinds(page).getByRole("button", { name: "Services", exact: true })).toHaveCount(0);
  expect((await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ collapsed_sections: ["network"] });

  // The keyboard: Enter and Space on the focused head.
  const config = sectionToggle(page, "Config");
  await config.focus();
  await page.keyboard.press("Enter");
  await expect(config).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press(" ");
  await expect(config).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");

  await page.reload();
  await expect(kinds(page).getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  await expect(sectionToggle(page, "Network")).toHaveAttribute("aria-expanded", "false");
  await expect(sectionToggle(page, "Config")).toHaveAttribute("aria-expanded", "false");
  await expect(sectionToggle(page, "Workloads")).toHaveAttribute("aria-expanded", "true");
  await expect(kinds(page).getByRole("button", { name: "Secrets", exact: true })).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("everything collapsed but Workloads fits an 800 px window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, (cluster) => {
    cluster.settings.collapsed_sections = ["network", "config", "storage", "cluster", "access", "devices", "helm", "custom", "other"];
  });
  await expect(kinds(page).getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  const body = page.locator(".chart-body");
  const { scroll, client } = await body.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(scroll).toBeLessThanOrEqual(client);
});

test("a collapsed section keeps the open view; Custom Resources hides its API groups", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Services");
  await sectionToggle(page, "Network").click();
  // Only the open view is left under the head.
  await expect(kinds(page).getByRole("button", { name: "Services", exact: true })).toHaveClass(/active/);
  await expect(kinds(page).getByRole("button", { name: "Ingresses", exact: true })).toHaveCount(0);
  await expect(kinds(page).getByRole("button", { name: "Port Forwards", exact: true })).toHaveCount(0);

  await sectionToggle(page, "Custom Resources").click();
  await expect(kinds(page).locator("summary", { hasText: "example.com" })).toHaveCount(0);
  await sectionToggle(page, "Custom Resources").click();
  await expect(kinds(page).locator("summary", { hasText: "example.com" })).toBeVisible();
});

test("a collapsed section counts the problems of its kinds", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  const badge = kinds(page).getByRole("button", { name: "Pods", exact: true }).getByTestId("problem-badge");
  await expect(badge).toBeVisible();
  const count = await badge.innerText();
  await openKind(page, "Services");
  await sectionToggle(page, "Workloads").click();
  await expect(sectionToggle(page, "Workloads").getByTestId("section-problems")).toHaveText(count);
});

const arn = (name: string) => `arn:aws:eks:eu-west-1:123456789012:cluster/${name}`;

test("long context names: the cluster name, and the full name in the tooltip", async ({ page }) => {
  const long = "team-platform-production-eu-west-1-cluster-blue-0123456789ab";
  await openApp(page, (cluster) => {
    const arn = (name: string) => `arn:aws:eks:eu-west-1:123456789012:cluster/${name}`;
    cluster.contexts = [
      { name: arn("payments-prod"), current: true, namespace: null },
      { name: arn("payments-staging"), current: false, namespace: null },
      { name: "team-platform-production-eu-west-1-cluster-blue-0123456789ab", current: false, namespace: null },
    ];
  });
  const node = (id: string) => page.locator(`[data-testid="cluster-node"][data-cluster="${id}"] > .row .name`);
  await expect(node(arn("payments-prod")).locator(".text")).toHaveText("payments-prod");
  await expect(node(arn("payments-staging")).locator(".text")).toHaveText("payments-staging");
  await expect(node(long).locator(".text")).toHaveText("team-plat…e-0123456789ab");
  await expect(node(arn("payments-staging"))).toHaveAttribute("title", new RegExp(`^${arn("payments-staging")}:`));

  // The status bar names the shown cluster the same way, with the full name in its tooltip.
  const status = page.getByTestId("status-cluster");
  await expect(status).toHaveText("payments-prod");
  await expect(status.getByTestId("cluster-label")).toHaveAttribute("title", new RegExp(arn("payments-prod")));
  // So does the header's context selector.
  const select = page.getByRole("combobox", { name: "Cluster context" });
  await expect(select.locator("option")).toHaveText(["payments-prod", "payments-staging", "team-plat…e-0123456789ab"]);
  await expect(select).toHaveAttribute("title", arn("payments-prod"));
  await node(arn("payments-staging")).click();
  await expect(status).toHaveText("payments-staging");
});

test("a label set in the catalog still wins over the short name", async ({ page }) => {
  await openApp(page, (cluster) => {
    const id = "arn:aws:eks:eu-west-1:123456789012:cluster/payments-prod";
    cluster.contexts = [{ name: id, current: true, namespace: null }];
    cluster.settings.contexts[id] = {
      view: "",
      namespaces: [],
      typed_namespaces: [],
      prometheus: "",
      display_name: "Payments",
      color: "",
      default_namespace: "",
      shell_cwd: "",
      last_used: 0,
      hide_metrics: false,
      mode: "normal",
      mode_source: { file: "", given: "", context: "" },
    };
  });
  await expect(page.getByTestId("status-cluster")).toHaveText("Payments");
  await expect(page.getByTestId("cluster-node").locator(".text").first()).toHaveText("Payments");
});
