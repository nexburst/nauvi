import { expect, test } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// A cluster that stays unreachable: the start is retried with a growing
// wait, then no more until the user asks (lib/retry.ts). One notice, not
// one per retry.

test("a start that keeps failing backs off, stops, and Refresh starts over", async ({ page }) => {
  await page.clock.install();
  const fake = await openApp(page, (_cluster, f) => {
    // The first start and its seven retries fail; the next start works.
    for (let i = 0; i < 8; i++) f.failNext("cmdOverviewStart", "Cannot reach the cluster at x");
  });
  const starts = async () => (await fake.calls("cmdOverviewStart")).length;
  await expect(page.getByRole("alert")).toContainText("Cannot reach the cluster at x");
  await expect.poll(starts).toBe(1);

  // 5 s, then 10 s, then 20 s: not every 5 s.
  await page.clock.runFor(5_500);
  await expect.poll(starts).toBe(2);
  await page.clock.runFor(5_500);
  expect(await starts()).toBe(2);
  await page.clock.runFor(5_000);
  await expect.poll(starts).toBe(3);
  // The error stays on screen through the retries: still one unread notice.
  await expect(page.getByRole("alert")).toContainText("Cannot reach the cluster at x");
  await expect(page.getByTestId("notification-count")).toHaveText("1");

  // The rest of the retries (20, 40, 60, 60, 60 s), then nothing more.
  for (let i = 0; i < 5; i++) await page.clock.runFor(61_000);
  await expect.poll(starts).toBe(8);
  await expect(page.getByRole("alert")).toContainText("Stopped retrying. Refresh to try again.");
  await page.clock.runFor(10 * 60_000);
  expect(await starts()).toBe(8);
  // Two notices in all: the failure, and that retrying stopped.
  await expect(page.getByTestId("notification-count")).toHaveText("2");

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(starts).toBe(9);
  await expect(page.locator("header")).toContainText("Live");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an overview that keeps reconnecting is stopped after five minutes; Refresh starts it again", async ({ page }) => {
  await page.clock.install();
  const fake = await openApp(page);
  await expect(page.locator("header")).toContainText("Live");
  const id = await fake.lastOverviewId();

  await fake.emitOverviewState({ state: "reconnecting", error: "Lost the connection to the cluster (https://x:6443); retrying." });
  await expect(page.getByRole("alert")).toContainText("retrying.");
  await page.clock.runFor(4 * 60_000);
  // The backend said it again meanwhile: the count does not start over.
  await fake.emitOverviewState({ state: "reconnecting", error: "Lost the connection to the cluster (https://x:6443); retrying." });
  expect(await fake.calls("cmdOverviewStop")).toEqual([]);

  await page.clock.runFor(61_000);
  await expect.poll(async () => (await fake.calls("cmdOverviewStop")).map((c) => c.id)).toEqual([id]);
  await expect(page.getByRole("alert")).toHaveText(
    "Lost the connection to the cluster (https://x:6443). Stopped retrying. Refresh to try again.",
  );
  await expect(page.locator("header")).toContainText("Not connected");

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("header")).toContainText("Live");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a watch that comes back within five minutes is left running", async ({ page }) => {
  await page.clock.install();
  const fake = await openApp(page);
  await expect(page.locator("header")).toContainText("Live");
  await fake.emitOverviewState({ state: "reconnecting", error: "The API server is not answering; retrying." });
  await page.clock.runFor(3 * 60_000);
  await fake.emitOverviewState({ state: "live" });
  await page.clock.runFor(10 * 60_000);
  expect(await fake.calls("cmdOverviewStop")).toEqual([]);
  await expect(page.locator("header")).toContainText("Live");
});

test("a table whose watch keeps reconnecting is stopped too, and keeps its rows", async ({ page }) => {
  await page.clock.install();
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(row(page, "crashed")).toBeVisible();
  const id = await fake.lastWatchId();

  await fake.emitWatchState({ state: "reconnecting", error: "Lost the connection to the cluster; retrying." });
  await expect(page.getByRole("alert")).toContainText("retrying.");
  await page.clock.runFor(5 * 60_000 + 1_000);
  await expect.poll(async () => (await fake.calls("cmdWatchStop")).map((c) => c.id)).toContain(id);
  await expect(page.getByRole("alert")).toContainText("Stopped retrying. Refresh to try again.");
  await expect(row(page, "crashed")).toBeVisible();
});
