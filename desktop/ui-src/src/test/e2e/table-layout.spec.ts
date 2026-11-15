import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// Header labels of the generic resource tables (#140): one that does not fit
// its column is cut with an ellipsis, and each header starts where its
// column's cells do, whatever width the scrollbar takes.

const grid = (page: Page) => page.getByTestId("resource-table").getByRole("grid");

/** Each header's left edge is within 1 px of its cells' in the row `name`. */
async function expectAligned(page: Page, name: string) {
  const heads = await grid(page)
    .getByRole("columnheader")
    .evaluateAll((ths) => ths.map((th) => th.getBoundingClientRect().left));
  const cells = await row(page, name)
    .getByRole("gridcell")
    .evaluateAll((tds) => tds.map((td) => td.getBoundingClientRect().left));
  expect(cells).toHaveLength(heads.length);
  for (let i = 0; i < heads.length; i++) {
    expect(Math.abs(heads[i] - cells[i]), `column ${i}`).toBeLessThanOrEqual(1);
  }
}

/** Labels of the headers whose content is wider than the header itself. */
async function overflowingHeaders(page: Page): Promise<string[]> {
  return grid(page)
    .getByRole("columnheader")
    .evaluateAll((ths) =>
      ths.filter((th) => th.scrollWidth > th.clientWidth + 1).map((th) => th.textContent?.trim() ?? ""),
    );
}

test("with a Service open, a header too wide for its column is cut with an ellipsis (#140)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await openKind(page, "Services");
  await expectAligned(page, "api");

  await row(page, "api").click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  // The columns are now at their minimum width: "EXTERNAL IP" does not fit.
  const external = grid(page).getByRole("columnheader", { name: "External IP" });
  await expect(external).toHaveAttribute("title", "External IP");
  const label = external.locator(".label");
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await label.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  // No label runs past its own header into the next one.
  expect(await overflowingHeaders(page)).toEqual([]);
  await expectAligned(page, "api");
});

test("a sorted, cut header keeps its arrow visible (#140)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await openKind(page, "Services");
  await row(page, "api").click();
  const external = grid(page).getByRole("columnheader", { name: "External IP" });
  await external.click();
  await expect(external).toHaveAttribute("aria-sort", "ascending");
  const [arrow, head] = await Promise.all([
    external.locator(".arrow").boundingBox(),
    external.boundingBox(),
  ]);
  expect(arrow!.x + arrow!.width).toBeLessThanOrEqual(head!.x + head!.width);
  expect(await overflowingHeaders(page)).toEqual([]);
});

test("with overlay scrollbars (no gutter, as in WebKitGTK), headers stay over their cells (#140)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  // WebKitGTK's overlay scrollbars take no width from the rows.
  await page.addStyleTag({ content: ".scroller::-webkit-scrollbar { width: 0; height: 0; }" });

  await openKind(page, "Nodes");
  await expectAligned(page, "node-1");
  await row(page, "node-1").click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  await expectAligned(page, "node-1");

  await openKind(page, "Services");
  await expectAligned(page, "api");
  await row(page, "api").click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  await expectAligned(page, "api");
  expect(await overflowingHeaders(page)).toEqual([]);
});
