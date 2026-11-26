// The table filter matches what the rows show (#512): "burst" listed every
// Burstable pod through the off-by-default QoS column. A cut cell that
// matches only in its hidden middle (#482) is marked, so the row shows why.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, row, rows } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

const filter = (page: Page) => page.getByRole("searchbox", { name: "Filter" });

async function toggleColumn(page: Page, label: string) {
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("dialog", { name: "Columns" }).getByRole("checkbox", { name: label, exact: true }).click();
  await page.keyboard.press("Escape");
}

test("an off-by-default column does not match until it is shown", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await expect(rows(page).first()).toBeVisible();
  // Every running pod is Burstable, in the QoS column nobody turned on.
  await filter(page).fill("burst");
  await expect(rows(page)).toHaveCount(0);
  await filter(page).fill("10.244.0.");
  await expect(rows(page)).toHaveCount(0);

  await toggleColumn(page, "QoS");
  await filter(page).fill("burst");
  await expect.poll(() => column(page, "QoS")).toEqual(expect.arrayContaining(["Burstable"]));
  expect(new Set(await column(page, "QoS"))).toEqual(new Set(["Burstable"]));
  // Off again: nothing matches.
  await toggleColumn(page, "QoS");
  await expect(rows(page)).toHaveCount(0);
});

test("a regex also matches only the shown columns", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await page.getByRole("button", { name: "Regular expression" }).click();
  await filter(page).fill("^Burstable$");
  await expect.poll(() => rows(page).count()).toBe(0);
  await toggleColumn(page, "QoS");
  await expect.poll(() => rows(page).count()).toBeGreaterThan(0);
  expect(new Set(await column(page, "QoS"))).toEqual(new Set(["Burstable"]));
});

const CANARY = "payments-worker-canary-7d9f8b6c5-x7k2p";
// Init functions run in the page as source text: no captured variables.
const longName = (cluster: FakeCluster) => {
  const pods = cluster.rows["v1/pods"];
  const base = pods[0];
  const [name, ns] = ["payments-worker-canary-7d9f8b6c5-x7k2p", "ux486-shop-payments"];
  const cells = [...base.cells];
  cells[0] = name;
  cells[1] = ns;
  pods.push({ ...base, key: `${ns}/${name}`, name, namespace: ns, cells });
};

test("a cut name that matches only in its hidden middle is marked", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openApp(page, longName);
  await openKind(page, "Pods");
  // The detail panel takes the room: the long name is cut in the middle.
  await row(page, "web-1").getByRole("gridcell").nth(1).click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();

  await filter(page).fill("7d9f8b6c5");
  await expect(rows(page)).toHaveCount(1);
  const name = rows(page).first().getByRole("gridcell").nth(1);
  await expect(name).toHaveClass(/\bcut\b/);
  await expect(name).not.toContainText("7d9f8b6c5");
  await expect(name).toHaveClass(/\bhit\b/);
  await expect(name).toHaveAttribute("title", `${CANARY} (matches the filter)`);
  await expect(name).toHaveAccessibleName(CANARY);

  // What the cell shows matches: no mark, the plain tooltip.
  await filter(page).fill("x7k2p");
  await expect(name).toHaveClass(/\bcut\b/);
  await expect(name).not.toHaveClass(/\bhit\b/);
  await expect(name).toHaveAttribute("title", CANARY);
});
