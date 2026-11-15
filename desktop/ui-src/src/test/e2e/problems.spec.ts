import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row, toggleNamespaces } from "./helpers";

const nav = (page: Page) => page.getByRole("navigation");
/** The problem badge beside a kind in the sidebar. */
const badge = (page: Page, label: string) =>
  nav(page).getByRole("button", { name: label, exact: true }).getByTestId("problem-badge");

test("the Overview's counts badge Pods; the Pods table highlights the problem rows", async ({ page }) => {
  const fake = await openApp(page);
  // The overview fixture has 2 problem pods and every node ready.
  await expect(badge(page, "Pods")).toHaveText("2");
  await expect(badge(page, "Pods")).toHaveAttribute("title", "2 Pods need attention across all namespaces");
  await expect(badge(page, "Pods")).not.toHaveClass(/stale/);
  await expect(badge(page, "Nodes")).toHaveCount(0);
  // Nothing watches Deployments yet, so they have no badge.
  await expect(badge(page, "Deployments")).toHaveCount(0);

  await openKind(page, "Pods");
  await expect(row(page, "crashed")).toHaveClass(/problem/);
  await expect(row(page, "crashed")).toHaveAttribute("data-problem", "CrashLoopBackOff");
  await expect(row(page, "db-0")).toHaveAttribute("data-problem", "Pending for 60m");
  await expect(row(page, "web-1")).not.toHaveClass(/problem/);
  await expect(row(page, "crashed").getByRole("gridcell").first()).toHaveAttribute("title", "CrashLoopBackOff");

  // The table's own watch keeps the badge current.
  await fake.emitWatchBatch({ applied: [fake.podRow("demo", "web-9", "ImagePullBackOff", "0", "ImagePullBackOff")] });
  await expect(badge(page, "Pods")).toHaveText("3");
  await fake.emitWatchBatch({ deleted: ["demo/crashed", "demo/db-0"] });
  await expect(badge(page, "Pods")).toHaveText("1");
  await expect(badge(page, "Pods")).toHaveAttribute("title", "1 Pod needs attention across all namespaces");
  await fake.emitWatchBatch({ applied: [fake.podRow("demo", "web-9", "Running")] });
  await expect(badge(page, "Pods")).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("badges come only from running watches and go stale when they stop", async ({ page }) => {
  const fake = await openApp(page);
  await expect(badge(page, "Pods")).toHaveText("2");

  await openKind(page, "Deployments");
  // demo/api has 1 of 3 replicas ready.
  await expect(row(page, "api")).toHaveAttribute("data-problem", "1 of 3 ready");
  await expect(row(page, "web")).not.toHaveClass(/problem/);
  await expect(badge(page, "Deployments")).toHaveText("1");
  // The overview's feed stopped: its Pods count stays, marked stale.
  await expect(badge(page, "Pods")).toHaveClass(/stale/);
  await expect(badge(page, "Pods")).toHaveAttribute("title", /when last watched/);
  // One watch, for the table on screen: nothing else is listed or polled.
  expect((await fake.activeWatches()).length).toBe(1);
  expect(await fake.overviewFeeds()).toEqual([]);

  await nav(page).getByRole("button", { name: "Overview", exact: true }).click();
  await expect(badge(page, "Pods")).not.toHaveClass(/stale/);
  await expect(badge(page, "Deployments")).toHaveClass(/stale/);
  expect(await fake.activeWatches()).toEqual([]);

  // A node goes NotReady: the overview's node count badges Nodes.
  await fake.emitOverview({ nodes: { total: 2, ready: 1 } });
  await expect(badge(page, "Nodes")).toHaveText("1");
  expect(fake.errors).toEqual([]);
});

test("a narrowed table's badge names its namespaces", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await expect(badge(page, "Pods")).toHaveText("2");
  // kube-system alone has no problem pods.
  await toggleNamespaces(page, "kube-system");
  await expect(badge(page, "Pods")).toHaveCount(0);
  await toggleNamespaces(page, "demo");
  await expect(badge(page, "Pods")).toHaveText("2");
  await expect(badge(page, "Pods")).toHaveAttribute("title", "2 Pods need attention in kube-system, demo");
});
