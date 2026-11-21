import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// Table and detail density (#384): headers keep the #390 capitals over sentence-case labels,
// short columns at about their content's width with the slack going to Name,
// and single-token values on one line with a title.

const grid = (page: Page) =>
  page.getByTestId("resource-table").getByRole("grid");
const header = (page: Page, name: string) =>
  grid(page).getByRole("columnheader", { name, exact: true });
const panel = (page: Page) => page.getByTestId("detail-panel");

const LONG_NODE =
  "ip-10-0-123-45.eu-west-1.compute.internal-with-a-much-longer-suffix-pool-a";

for (const theme of ["light", "dark"] as const) {
  for (const rows of ["normal", "compact"] as const) {
    test(`headers keep their capitals; the Pods table fits (${theme}, ${rows} rows)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openApp(
        page,
        rows === "compact"
          ? (c) => (c.settings.row_height = "compact")
          : undefined,
      );
      await page.evaluate(
        (t) => (document.documentElement.dataset.theme = t),
        theme,
      );
      await openKind(page, "Pods");
      await expect(row(page, "web-1")).toBeVisible();
      // Compact rows from #355 still apply.
      expect(Math.round((await row(page, "web-1").boundingBox())!.height)).toBe(
        rows === "compact" ? 22 : 28,
      );
      const name = header(page, "Name");
      const style = await name.evaluate((th) => {
        const s = getComputedStyle(th);
        const cell = document.querySelector(
          '[data-testid="resource-row"] [role="gridcell"]:nth-child(2)',
        )!;
        return {
          transform: s.textTransform,
          size: s.fontSize,
          cell: getComputedStyle(cell).fontSize,
        };
      });
      expect(style.transform).toBe("uppercase");
      // The default Pods table still fits 1280 px (#417).
      const scroller = page.locator(".table .scroller");
      expect(
        await scroller.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: test.info().outputPath(`pods-${theme}-${rows}.png`),
      });
    });
  }
}

test("a two-word label reads in sentence case (#384)", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await page.getByRole("button", { name: "Columns" }).click();
  await page
    .getByRole("checkbox", { name: "Controlled by", exact: true })
    .check();
  await expect(header(page, "Controlled by")).toBeVisible();
});

test("on Deployments the slack goes to Name, not to the short columns (#384)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await openKind(page, "Deployments");
  await expect(
    grid(page).getByRole("columnheader", { name: "Name", exact: true }),
  ).toBeVisible();
  const width = async (n: string) =>
    (await header(page, n).boundingBox())!.width;
  const [name, ready, uptodate, available] = await Promise.all(
    ["Name", "Ready", "Up-to-date", "Available"].map(width),
  );
  for (const w of [ready, uptodate, available])
    expect(w).toBeLessThanOrEqual(112);
  expect(name).toBeGreaterThan(2 * Math.max(ready, uptodate, available));
  // No label is cut at this width.
  const cut = await grid(page)
    .getByRole("columnheader")
    .evaluateAll((ths) =>
      ths
        .flatMap((th) => Array.from(th.querySelectorAll(".label")))
        .filter((l) => l.scrollWidth > l.clientWidth + 1)
        .map((l) => l.textContent),
    );
  expect(cut).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("deployments.png") });
});

test("the detail panel opens at 420 px; a long node name is on one line with a title (#384)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, (c) => {
    c.details["v1/pods|demo/web-1"].pod!.node =
      "ip-10-0-123-45.eu-west-1.compute.internal-with-a-much-longer-suffix-pool-a";
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page)).toBeVisible();
  expect(Math.round((await panel(page).boundingBox())!.width)).toBe(420);

  const node = panel(page).getByTestId("meta-node");
  await expect(node).toHaveText(LONG_NODE);
  await expect(node).toHaveAttribute("title", LONG_NODE);
  const box = await node.evaluate((dd) => {
    const s = getComputedStyle(dd);
    return {
      height: dd.getBoundingClientRect().height,
      line: parseFloat(s.lineHeight) || 1.5 * parseFloat(s.fontSize),
      cut: dd.scrollWidth > dd.clientWidth,
      overflow: s.textOverflow,
    };
  });
  // One line, cut with an ellipsis.
  expect(box.height).toBeLessThan(box.line * 1.5);
  expect(box.cut).toBe(true);
  expect(box.overflow).toBe("ellipsis");
  // The whole value is still there to select and copy.
  expect(await node.evaluate((dd) => getComputedStyle(dd).userSelect)).not.toBe(
    "none",
  );
  await page.screenshot({
    path: test.info().outputPath("pod-detail-long-node.png"),
  });
});

test("a long panel title wraps clear of the Widen button (#384)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const long = "web-with-a-very-long-name-that-goes-on-and-on-past-the-header";
  await openApp(page, (c) => {
    const n = "web-with-a-very-long-name-that-goes-on-and-on-past-the-header";
    const r = c.rows["v1/pods"].find((x) => x.name === "web-1")!;
    r.name = n;
    r.key = `demo/${n}`;
    r.cells[0] = n;
    c.details[`v1/pods|demo/${n}`] = { ...c.details["v1/pods|demo/web-1"], name: n };
  });
  await openKind(page, "Pods");
  await row(page, long).click();
  const title = panel(page).locator(".title");
  await expect(title).toHaveText(`demo/${long}`);
  const [t, w] = await Promise.all([title.boundingBox(), page.getByTestId("widen").boundingBox()]);
  // The text wraps before the button: its line box ends left of it.
  const textRight = await title.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return Math.max(...Array.from(r.getClientRects(), (x) => x.right));
  });
  expect(t!.height).toBeGreaterThan(20);
  expect(textRight).toBeLessThanOrEqual(w!.x);
});

test("a message wraps between words, never inside one (#384)", async ({
  page,
}) => {
  await openApp(page, (c) => {
    c.details["v1/pods|demo/web-1"].pod!.message =
      "The node was low on resource: ephemeral-storage. Threshold quantity: 1Gi, available: 512Mi.";
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  const msg = panel(page)
    .locator("dt", { hasText: "Message" })
    .locator("xpath=following-sibling::dd[1]");
  await expect(msg).toContainText("ephemeral-storage");
  const style = await msg.evaluate((dd) => {
    const s = getComputedStyle(dd);
    return { wordBreak: s.wordBreak, wrap: s.overflowWrap };
  });
  expect(style.wordBreak).toBe("normal");
  expect(style.wrap).toBe("break-word");
});

test("at its minimum width the detail panel does not scroll sideways (#384)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, (c) => {
    c.details["v1/pods|demo/web-1"].pod!.node =
      "ip-10-0-123-45.eu-west-1.compute.internal-with-a-much-longer-suffix-pool-a";
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator(".card").first()).toBeVisible();
  // Drag the resizer far to the right: the panel stops at its minimum.
  const handle = page.getByTestId("panel-resizer");
  const b = (await handle.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 100);
  await page.mouse.down();
  await page.mouse.move(1270, b.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await panel(page).boundingBox())!.width))
    .toBe(320);
  const sideways = await panel(page).evaluate(
    (p) => p.scrollWidth - p.clientWidth,
  );
  expect(sideways).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath("pod-detail-min.png") });
});
