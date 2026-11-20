// The status bar's time and the cluster's version (#387).
import { expect, test } from "@playwright/test";
import { openApp, openKind, rows } from "./helpers";

const footer = (page: import("@playwright/test").Page) => page.locator("footer");
const LIVE = /^Live · last change (\d\d:\d\d:\d\d)$/;

test("the cluster's version shows next to its name", async ({ page }) => {
  const fake = await openApp(page);
  await expect(footer(page).getByTestId("status-version")).toHaveText("v1.31.2");
  await expect(footer(page).getByTestId("status-cluster")).toBeVisible();
  expect(await fake.calls("cmdServerVersion")).not.toHaveLength(0);
  expect(fake.errors).toEqual([]);
});

test("a cluster that does not say its version shows none, and no error", async ({ page }) => {
  const fake = await openApp(page, (c) => {
    c.serverVersion = "";
  });
  await openKind(page, "Pods");
  await expect(rows(page).first()).toBeVisible();
  await expect.poll(() => fake.calls("cmdServerVersion").then((c) => c.length)).toBeGreaterThan(0);
  await expect(footer(page).getByTestId("status-version")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(footer(page).getByTestId("status-cluster")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("a live table says Live and when it last changed; a reconnect or batch moves the time", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-20T10:00:00") });
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(rows(page).first()).toBeVisible();
  const time = footer(page).getByTestId("status-time");
  await expect(time).toHaveText(LIVE);
  const first = (await time.textContent())!.match(LIVE)![1];

  // Ten quiet minutes: the rows are current, the label still says so.
  await page.clock.fastForward(10 * 60_000);
  await expect(time).toHaveText(`Live · last change ${first}`);

  // The watch drops: the rows are as of the last change.
  await fake.emitWatchState({ state: "reconnecting", error: "Lost the connection; retrying." });
  await expect(time).toHaveText(`Stale since ${first}`);
  await expect(time).toHaveClass(/stale/);

  // It comes back without a re-list (no batch): current again from now.
  await fake.emitWatchState({ state: "live" });
  await expect(time).toHaveText(LIVE);
  const back = (await time.textContent())!.match(LIVE)![1];
  expect(back).not.toBe(first);

  // A batch is a change.
  await page.clock.fastForward(3 * 60_000);
  await fake.emitWatchBatch({ deleted: ["demo/web-1"] });
  await expect(time).toHaveText(LIVE);
  await expect(time).not.toHaveText(`Live · last change ${back}`);
  expect(fake.errors).toEqual([]);
});

test("a re-list (snapshot) after a quiet spell moves the time", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-20T10:00:00") });
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(rows(page).first()).toBeVisible();
  const time = footer(page).getByTestId("status-time");
  await expect(time).toHaveText(LIVE);
  const first = (await time.textContent())!.match(LIVE)![1];
  await page.clock.fastForward(5 * 60_000);
  await fake.emitWatchBatch({ snapshot: true, applied: [fake.podRow("demo", "web-1")] });
  await expect(rows(page)).toHaveCount(1);
  await expect(time).toHaveText(LIVE);
  await expect(time).not.toHaveText(`Live · last change ${first}`);
  expect(fake.errors).toEqual([]);
});
