import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, row } from "./helpers";

// The app's default navigation: no sidebar. The chart of kinds is summoned
// (G or the compass) and the wake keeps a spine for every stop. The other
// specs drive the chart pinned as a column (see src/test/main.ts).
async function openFloating(page: Page) {
  await page.addInitScript(() => localStorage.setItem("nauvi.chart.pinned", "0"));
  const fake = await openApp(page, undefined, { waitForKinds: false });
  await expect(page.getByTestId("deck-headline")).toBeVisible();
  return fake;
}

const spine = (page: Page, name: string) => page.getByRole("button", { name: `Wake: ${name}`, exact: true });

test("G summons the chart; a short name and Enter open the kind and close it", async ({ page }) => {
  await openFloating(page);
  await expect(page.getByRole("navigation")).toHaveCount(0);

  await page.keyboard.press("g");
  const chart = page.getByTestId("chart");
  await expect(chart).toBeVisible();
  await expect(page.getByTestId("chart-lens")).toBeFocused();
  // Empty lens: what needs a look comes first, the whole catalog is below.
  await expect(page.getByTestId("chart-quick")).toContainText("Needs a look");
  await expect(chart.getByRole("button", { name: "Stateful Sets" }).or(chart.getByRole("button", { name: "StatefulSets" }))).toBeVisible();

  await page.keyboard.type("po");
  await page.keyboard.press("Enter");
  await expect(chart).toHaveCount(0);
  await expect(row(page, "crashed")).toBeVisible();
  await expect(spine(page, "Pods")).toHaveAttribute("aria-current", "page");
  await expect(spine(page, "Overview")).toBeVisible();

  // Escape closes a summoned chart without leaving the view.
  await page.getByTestId("chart-toggle").click();
  await expect(chart).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chart).toHaveCount(0);
  await expect(row(page, "crashed")).toBeVisible();
});

test("an opened object joins the wake after its view, and can take the whole sheet", async ({ page }) => {
  await openFloating(page);
  await page.keyboard.press("g");
  await page.keyboard.type("po");
  await page.keyboard.press("Enter");
  await row(page, "crashed").click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();

  const names = () => page.getByTestId("spine").locator(".name").allTextContents();
  await expect.poll(names).toEqual(["Overview", "Pods", "crashed"]);
  // The Pods spine carries a tick per row; the failing ones are marked.
  await expect(page.getByTestId("spine").nth(1).locator(".tick")).toHaveCount(5);
  await expect(page.getByTestId("spine").nth(1).locator(".tick.bad")).toHaveCount(1);

  await page.getByTestId("fold-table").click();
  await expect(page.getByTestId("resource-table")).toBeHidden();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  // Back to the table through its spine.
  await page.getByTestId("fold-table").click();
  await expect(row(page, "web-1")).toBeVisible();

  // A tick opens its object.
  await page.getByTestId("spine").nth(1).locator(".tick").nth(2).click();
  await expect(page.getByTestId("detail-panel")).toContainText("web-1");
  await expect.poll(names).toEqual(["Overview", "Pods", "crashed", "web-1"]);
});

test("the chart can be pinned as a column and floated again", async ({ page }) => {
  await openFloating(page);
  await page.keyboard.press("g");
  await page.getByRole("button", { name: "Pin as column" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  await page.getByTestId("chart-unpin").click();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByTestId("chart-toggle")).toBeVisible();
});

test("the watch dial opens the watch; a cleared problem ties a knot on the wake line", async ({ page }) => {
  const fake = await openFloating(page);
  await expect(page.getByTestId("deck-headline")).toHaveText("2 pods need a look");
  await fake.emitOverview({
    pods: {
      namespace: null,
      total: 5,
      running: 4,
      pending: 0,
      succeeded: 0,
      failed: 0,
      waiting_errors: 1,
      by_namespace: [["demo", 5]],
      problems: [
        { namespace: "demo", name: "crashed", status: "CrashLoopBackOff", reason: "CrashLoopBackOff", restarts: 12, created: 0 },
      ],
      problems_total: 1,
    },
  });
  await expect(page.getByTestId("deck-headline")).toHaveText("1 pod needs a look");
  await expect(page.getByTestId("wake-line").locator(".knot")).toHaveCount(1);

  await page.getByTestId("watch-dial").click();
  const watch = page.getByTestId("watch-panel");
  await expect(watch).toContainText("1 cleared today");
  await expect(watch).toContainText("Steady hand");
});
