// The table filter's toggles and saved searches (#219).

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, rows } from "./helpers";

const filter = (page: Page) => page.getByRole("searchbox", { name: "Filter" });
const matchCase = (page: Page) => page.getByRole("button", { name: "Match case" });
const regex = (page: Page) => page.getByRole("button", { name: "Regular expression" });
const suggestions = (page: Page) => page.getByRole("listbox", { name: "Saved searches" });
const filterError = (page: Page) => page.getByTestId("table-filter-error");

test("the default filter is unchanged: plain text, ignoring case", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await expect(matchCase(page)).toHaveAttribute("aria-pressed", "false");
  await expect(regex(page)).toHaveAttribute("aria-pressed", "false");
  await filter(page).fill(" WEB ");
  expect(await column(page, "Name")).toEqual(["web-1", "web-2"]);
  // Regex characters are plain text by default.
  await filter(page).fill("web-.");
  await expect(rows(page)).toHaveCount(0);
});

test("match case and regex narrow the rows; ^ and $ match per field", async ({ page }) => {
  await openApp(page, (c) => {
    const p = c.rows["v1/pods"][0];
    p.name = "Web-1";
    p.key = "demo/Web-1";
    // Every cell, the Controlled By one (#378) too: "web" must not match it.
    p.cells = p.cells.map((c) => c.replace("web", "Web"));
  });
  await openKind(page, "Pods");
  await filter(page).fill("web");
  expect(await column(page, "Name")).toEqual(["Web-1", "web-2"]);
  await matchCase(page).click();
  await expect(matchCase(page)).toHaveAttribute("aria-pressed", "true");
  expect(await column(page, "Name")).toEqual(["web-2"]);
  await matchCase(page).click();

  await regex(page).click();
  await expect(filter(page)).toHaveAttribute("placeholder", "Filter (regex)…");
  await filter(page).fill("^(web|db)-\\d$");
  // Key order: "demo/Web-1" sorts before "demo/db-0".
  await expect.poll(() => column(page, "Name")).toEqual(["Web-1", "db-0", "web-2"]);
  await expect(page.getByText("3 of 5 items")).toBeVisible();
  // A field, not the whole row: the namespace "demo" is its own line.
  await filter(page).fill("^kube-system$");
  await expect.poll(() => column(page, "Name")).toEqual(["coredns-1"]);
  await matchCase(page).click();
  await filter(page).fill("^Web");
  await expect.poll(() => column(page, "Name")).toEqual(["Web-1"]);
});

test("an invalid regex is shown inline and the last good filter stays", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await regex(page).click();
  await filter(page).fill("^web");
  await expect.poll(() => column(page, "Name")).toEqual(["web-1", "web-2"]);
  await filter(page).fill("^web-(");
  await expect(filterError(page)).toContainText("Invalid regex");
  await expect(filter(page)).toHaveAttribute("aria-invalid", "true");
  expect(await column(page, "Name")).toEqual(["web-1", "web-2"]);
  await filter(page).fill("^web-(1)");
  await expect(filterError(page)).toHaveCount(0);
  await expect.poll(() => column(page, "Name")).toEqual(["web-1"]);
  // Turning regex off makes it plain text again.
  await filter(page).fill("(");
  await expect(filterError(page)).toBeVisible();
  await regex(page).click();
  await expect(filterError(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
});

test("a regex that backtracks for ever is stopped, and the app stays usable", async ({ page }) => {
  await openApp(page, (c) => {
    const p = structuredClone(c.rows["v1/pods"][0]);
    p.name = "a".repeat(34) + "-x";
    p.key = "demo/" + p.name;
    p.cells[0] = p.name;
    c.rows["v1/pods"].push(p);
  });
  await openKind(page, "Pods");
  await regex(page).click();
  await filter(page).fill("^(a+)+$");
  await expect(filterError(page)).toContainText("Regex too slow", { timeout: 10_000 });
  // The UI thread is free: the toggles and the box still work.
  await regex(page).click();
  await expect(filterError(page)).toHaveCount(0);
  await filter(page).fill("web-1");
  expect(await column(page, "Name")).toEqual(["web-1"]);
});

test("searches are remembered, offered in every list, starred and removed", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await filter(page).fill("web");
  await filter(page).press("Enter");
  await regex(page).click();
  await filter(page).fill("^db-");
  await filter(page).press("Enter");
  const saved = await fake.lastCall("cmdUpdateSettings");
  expect(JSON.stringify(saved)).toContain('"^db-"');

  // Another list, the box cleared: ArrowDown offers both, newest first.
  await openKind(page, "Deployments");
  await filter(page).fill("");
  await filter(page).press("ArrowDown");
  const list = suggestions(page);
  await expect(list.getByRole("option")).toHaveText([/\/\^db-\//, /web/]);

  // Picking one puts it back with its toggles.
  await filter(page).press("ArrowDown");
  await filter(page).press("Enter");
  await expect(filter(page)).toHaveValue("web");
  await expect(regex(page)).toHaveAttribute("aria-pressed", "false");
  expect(await column(page, "Name")).toEqual(["web"]);

  // Star the one in the box: it comes first and has no remove button.
  await page.getByRole("button", { name: "Star this search" }).click();
  await expect(page.getByRole("button", { name: "Star this search" })).toHaveAttribute("aria-pressed", "true");
  await filter(page).fill("");
  await filter(page).press("ArrowDown");
  await expect(list.getByRole("option")).toHaveText([/web/, /\/\^db-\//]);
  await expect(list.getByRole("option").first()).toHaveAttribute("aria-label", "web (starred)");
  await expect(list.getByRole("button", { name: "Remove web" })).toHaveCount(0);

  // Typing narrows the suggestions; a recent one can be removed.
  await filter(page).fill("db");
  await expect(list.getByRole("option")).toHaveText([/\/\^db-\//]);
  await list.getByRole("button", { name: "Remove /^db-/" }).click();
  await expect(list).toHaveCount(0);
  await expect(filter(page)).toBeFocused();

  // Escape closes the list and leaves the detail panel / view alone.
  await filter(page).fill("");
  await filter(page).press("ArrowDown");
  await expect(list).toBeVisible();
  await filter(page).press("Escape");
  await expect(list).toHaveCount(0);

  // Kept across a restart (the fake keeps its settings over a reload).
  await page.reload();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  await openKind(page, "Pods");
  await filter(page).press("ArrowDown");
  await expect(suggestions(page).getByRole("option")).toHaveText([/web/]);
  expect(fake.errors).toEqual([]);
});

test("Helm releases use the same toggles", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation").getByRole("button", { name: "Releases", exact: true }).click();
  await expect(page.getByTestId("helm-row")).toHaveCount(2);
  await regex(page).click();
  // ^ and $ per field: the release name "metrics", not its chart.
  await filter(page).fill("^metrics$");
  await expect(page.getByTestId("helm-row")).toHaveCount(1);
  await expect(page.getByTestId("helm-row")).toContainText("kube-system");
  await filter(page).fill("^(web|metrics)$");
  await expect(page.getByTestId("helm-row")).toHaveCount(2);
  await filter(page).fill("^nothing$");
  await expect(page.getByTestId("helm-row")).toHaveCount(0);
});
