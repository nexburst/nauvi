import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// The Pods table's Containers column (#379): one state square per container.

const header = (page: Page) => page.getByRole("columnheader", { name: /^Containers/ });
const squares = (page: Page, name: string) => row(page, name).getByTestId("container-square");

async function showColumn(page: Page) {
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Columns" });
  await expect(chooser.getByRole("checkbox", { name: "Containers", exact: true })).not.toBeChecked();
  await chooser.getByRole("checkbox", { name: "Containers", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(header(page)).toBeVisible();
}

/** WCAG relative luminance of a CSS `rgb(...)` colour. */
function luminance(css: string): number {
  const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const colour = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);

test("the Containers column is off by default; on, it shows a square per container", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(header(page)).toHaveCount(0);
  await showColumn(page);

  // web-1: the init container first, set apart, then app and sidecar.
  const web1 = squares(page, "web-1");
  await expect(web1).toHaveCount(3);
  await expect(web1.nth(0)).toHaveAttribute("title", "init container init-db: completed");
  await expect(web1.nth(0)).toHaveAttribute("data-look", "done");
  await expect(web1.nth(1)).toHaveAttribute("title", "app: running, ready");
  await expect(web1.nth(2)).toHaveAttribute("data-look", "ok");

  // A crash-looping sidecar next to a ready app.
  const web2 = squares(page, "web-2");
  await expect(web2).toHaveCount(2);
  await expect(web2.nth(1)).toHaveAttribute("title", "sidecar: waiting, CrashLoopBackOff");
  await expect(web2.nth(1)).toHaveAttribute("data-look", "bad");
  await expect(squares(page, "crashed").first()).toHaveAttribute("data-look", "bad");
  await expect(squares(page, "db-0").first()).toHaveAttribute("data-look", "unknown");

  // Not colour only: the squares are hidden from screen readers, and the cell
  // says what they show; its tooltip too.
  const cell = row(page, "web-2")
    .getByRole("gridcell")
    .filter({ has: page.getByTestId("container-squares") });
  await expect(cell).toHaveAttribute("title", "2 containers: app: running, ready; sidecar: waiting, CrashLoopBackOff");
  await expect(cell).toContainText("2 containers: app: running, ready; sidecar: waiting, CrashLoopBackOff");
  await expect(web2.first()).toHaveAttribute("aria-hidden", "true");
  expect(fake.errors).toEqual([]);
});

test("sorting by Containers puts the pods with a broken container first", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await showColumn(page);
  await header(page).click();
  await header(page).click();
  await expect(header(page)).toHaveAttribute("aria-sort", "descending");
  const names = await page
    .getByTestId("resource-row")
    .evaluateAll((rows) => rows.map((r) => r.querySelectorAll('[role="gridcell"]')[1]?.textContent?.trim()));
  // Both broken pods (one red square each) above the healthy ones.
  expect(names.slice(0, 2).sort()).toEqual(["crashed", "web-2"]);
});

for (const theme of ["light", "dark"] as const) {
  test(`the squares stand out from the row and from each other (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await openKind(page, "Pods");
    await showColumn(page);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [done, ok] = [squares(page, "web-1").nth(0), squares(page, "web-1").nth(1)];
    const bad = squares(page, "web-2").nth(1);
    const unknown = squares(page, "db-0").nth(0);
    const colours = await Promise.all([ok, bad, done, unknown].map(colour));
    // 3:1 against the background, as WCAG asks of graphics.
    for (const c of colours) expect(contrast(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(3);
    // Green and red differ, and each look has its own shape besides.
    expect(colours[0]).not.toBe(colours[1]);
    // A shape: the SVG's elements with their fill and dashes.
    const shape = (l: Locator) =>
      l
        .locator("svg > *")
        .evaluateAll((els) =>
          els
            .map(
              (e) =>
                `${e.tagName}:${e.getAttribute("fill")}:${e.getAttribute("stroke-dasharray")}:${e.getAttribute("y")}`,
            )
            .join(" "),
        );
    const shapes = await Promise.all([ok, bad, done, unknown].map(shape));
    expect(new Set(shapes).size).toBe(4);
    await page.locator(".table .scroller").evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await expect(squares(page, "web-1").first()).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath(`container-squares-${theme}.png`),
    });
  });
}
