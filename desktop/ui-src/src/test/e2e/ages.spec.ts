import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// kubectl-style ages and the creation time (#380). The clock is fixed so the
// ages are exact: web-1 was created 7d 20h 5m before "now".
const NOW = new Date("2026-11-17T10:07:03Z");

const panel = (page: Page) => page.locator("aside");

async function open(page: Page, zone: "local" | "utc") {
  await page.clock.setFixedTime(NOW);
  const fake = await openApp(
    page,
    new Function(
      "c",
      `const created = Date.UTC(2026, 10, 9, 14, 2, 3) / 1000;
       c.settings.time_zone = ${JSON.stringify(zone)};
       c.rows["v1/pods"].find((r) => r.name === "web-1").created = created;
       c.rows["v1/pods"].find((r) => r.name === "web-2").created = created + 4 * 86400 + 6 * 3600;
       const d = c.details["v1/pods|demo/web-1"];
       d.created = created;
       d.age = "7d20h";`,
    ) as Parameters<typeof openApp>[1],
  );
  await openKind(page, "Pods");
  return fake;
}

function cell(page: Page, name: string, text: string) {
  return row(page, name).getByRole("gridcell", { name: text, exact: true });
}

test("the Age column prints two units like kubectl and the creation time as its tooltip", async ({ page }) => {
  const fake = await open(page, "utc");
  await expect(cell(page, "web-1", "7d20h")).toHaveAttribute("title", "Created 2026-11-09 14:02:03 UTC");
  await expect(cell(page, "web-2", "3d14h")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("the detail panel shows the age with the creation time in UTC", async ({ page }) => {
  const fake = await open(page, "utc");
  await row(page, "web-1").click();
  await expect(panel(page).getByTestId("meta-age")).toHaveText("7d20h (2026-11-09 14:02:03 UTC)");
  expect(fake.errors).toEqual([]);
});

test("in local time the creation time has no zone suffix", async ({ page }) => {
  const fake = await open(page, "local");
  await row(page, "web-1").click();
  await expect(panel(page).getByTestId("meta-created")).toHaveText(/^\(2026-11-\d\d \d\d:\d\d:03\)$/);
  await expect(cell(page, "web-1", "7d20h")).toHaveAttribute("title", /^Created 2026-11-\d\d \d\d:\d\d:03$/);
  expect(fake.errors).toEqual([]);
});
