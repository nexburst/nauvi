// A cluster that does not answer (#462, #469): the header status is the one
// source of truth, and the tree's dot, the banner and the views' empty
// states follow it. Views that watch nothing (Port Forwards, Helm, the
// catalog) find out through a health check every 10 s.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind } from "./helpers";

const node = (page: Page, id: string) => page.locator(`[data-testid="cluster-node"][data-cluster="${id}"]`);
const visibleDot = (page: Page) => page.locator('[data-testid="cluster-node"][data-state="visible"] .dot');
const status = (page: Page) => page.getByTestId("connection-status");
const LOST = "Lost the connection to the cluster (https://127.0.0.1:6443); retrying.";

test("an overview that cannot start: red dot, the banner and a state with Retry now", async ({ page }) => {
  const fake = await openApp(page, (_cluster, f) => f.failNext("cmdOverviewStart", "Cannot reach the cluster for `kind-dev`"));
  await expect(status(page)).toHaveText("Cluster unreachable");
  await expect(page.getByRole("alert")).toContainText("Cannot reach the cluster for `kind-dev`");
  await expect(visibleDot(page)).toHaveClass(/failed/);
  await expect(node(page, "kind-dev").locator("button.name")).toHaveAttribute(
    "title",
    /Cluster unreachable/,
  );
  const state = page.getByTestId("out-of-reach");
  await expect(state).toContainText("Cluster unreachable");
  await expect(state).toContainText("The banner above says what failed");

  // Retry now starts the feed again at once; the second start works.
  const before = (await fake.calls("cmdOverviewStart")).length;
  await state.getByRole("button", { name: "Retry now" }).click();
  await expect.poll(async () => (await fake.calls("cmdOverviewStart")).length).toBeGreaterThan(before);
  await expect(status(page)).toHaveText("Live");
  await expect(state).toHaveCount(0);
  await expect(visibleDot(page)).toHaveClass(/connected/);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an empty table says the cluster is not answering instead of No items found", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.rows["v1/pods"] = [];
  });
  await openKind(page, "Pods");
  await expect(status(page)).toHaveText("Live");
  await expect(page.getByText("No items found.")).toBeVisible();

  await fake.emitWatchState({ state: "reconnecting", error: LOST });
  await expect(status(page)).toHaveText("Reconnecting…");
  await expect(visibleDot(page)).toHaveClass(/failed/);
  await expect(page.getByTestId("out-of-reach")).toContainText("Reconnecting…");
  await expect(page.getByText("No items found.")).toHaveCount(0);

  await fake.emitWatchState({ state: "live" });
  await expect(status(page)).toHaveText("Live");
  await expect(visibleDot(page)).toHaveClass(/connected/);
  await expect(page.getByText("No items found.")).toBeVisible();
});

test("Port Forwards checks the cluster every 10 s and says when it goes away and comes back", async ({ page }) => {
  await page.clock.install();
  const fake = await openApp(page);
  await openKind(page, "Port Forwards");
  await expect(status(page)).toHaveText("Live");
  await expect.poll(async () => (await fake.calls("cmdClusterHealth")).length).toBe(1);

  await page.evaluate((e) => (window.__fake.cluster.healthError = e), LOST);
  await page.clock.runFor(10_000);
  await expect(status(page)).toHaveText("Cluster unreachable");
  await expect(page.getByRole("alert")).toHaveText(LOST);
  await expect(visibleDot(page)).toHaveClass(/failed/);
  // The forwards are local: their (empty) list stays.
  await expect(page.getByTestId("forwards-empty")).toBeVisible();

  await page.evaluate(() => (window.__fake.cluster.healthError = ""));
  await page.clock.runFor(10_000);
  await expect(status(page)).toHaveText("Live");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(visibleDot(page)).toHaveClass(/connected/);

  // Another view: the checks stop.
  await openKind(page, "Pods");
  const checks = (await fake.calls("cmdClusterHealth")).length;
  await page.clock.runFor(30_000);
  expect((await fake.calls("cmdClusterHealth")).length).toBe(checks);
  expect(fake.errors).toEqual([]);
});

test("Refresh on Helm checks the cluster at once", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Releases");
  await expect.poll(async () => (await fake.calls("cmdClusterHealth")).length).toBe(1);
  await page.evaluate((e) => (window.__fake.cluster.healthError = e), LOST);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(status(page)).toHaveText("Cluster unreachable");
  await expect(visibleDot(page)).toHaveClass(/failed/);
});
