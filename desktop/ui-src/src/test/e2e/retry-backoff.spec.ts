import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

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
