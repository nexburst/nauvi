import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, row } from "./helpers";
import { problemGroups } from "../fixtures/overview";

// The app's default shell: no sidebar. Kinds open in a drawer (G), and the
// places kept at hand are berths the user pins and removes. The other specs
// drive the kinds pinned as a column (see src/test/main.ts).
async function openFloating(page: Page) {
  await page.addInitScript(() => localStorage.setItem("nauvi.chart.pinned", "0"));
  const fake = await openApp(page, undefined, { waitForKinds: false });
  await expect(page.getByTestId("deck-headline")).toBeVisible();
  return fake;
}

const berths = (page: Page) => page.getByTestId("berth").locator(".code");

test("G opens the drawer of kinds; a kubectl name and Enter open the kind and close it", async ({ page }) => {
  await openFloating(page);
  await expect(page.getByRole("navigation")).toHaveCount(0);

  await page.keyboard.press("g");
  const drawer = page.getByTestId("chart");
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId("chart-lens")).toBeFocused();
  await expect(page.getByTestId("chart-quick")).toContainText("Needs a look");
  await expect(drawer.getByRole("button", { name: "StatefulSets", exact: true })).toBeVisible();

  await page.keyboard.type("po");
  await page.keyboard.press("Enter");
  await expect(drawer).toHaveCount(0);
  await expect(row(page, "crashed")).toBeVisible();

  // Escape closes the drawer without leaving the view.
  await page.getByTestId("chart-toggle").click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(row(page, "crashed")).toBeVisible();
});

test("berths are only added by the user, answer to 1-9, and can be removed", async ({ page }) => {
  await openFloating(page);
  // A new install: the Overview and three kinds most sessions start with.
  await expect(berths(page)).toHaveText(["ov", "po", "dep", "svc"]);

  // Visiting views adds nothing.
  await page.keyboard.press("g");
  await page.keyboard.type("secrets");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("resource-table")).toBeVisible();
  await expect(berths(page)).toHaveText(["ov", "po", "dep", "svc"]);

  // The view on screen is offered a berth; P (or the cell) keeps it.
  await expect(page.getByTestId("berth-keep")).toBeVisible();
  await page.keyboard.press("p");
  await expect(berths(page)).toHaveCount(5);
  await expect(page.getByTestId("berth-keep")).toHaveCount(0);

  // Keys go to berths: 2 is Pods, 1 the Overview.
  await page.keyboard.press("2");
  await expect(row(page, "crashed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Berth 2: Pods" })).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("1");
  await expect(page.getByTestId("deck-headline")).toBeVisible();

  // Any berth but the Overview can be removed, and stays removed.
  await page.getByRole("button", { name: "Remove the Services berth" }).click({ force: true });
  await expect(berths(page)).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Remove the Overview berth" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("deck-headline")).toBeVisible();
  await expect(berths(page)).toHaveCount(4);
});

test("no more than eight berths: the ninth is refused", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("nauvi.berths", JSON.stringify(["a/1", "a/2", "a/3", "a/4", "a/5", "a/6", "a/7", "a/8"])),
  );
  await openFloating(page);
  await page.keyboard.press("g");
  await page.keyboard.type("po");
  await page.keyboard.press("Enter");
  await expect(row(page, "crashed")).toBeVisible();
  await page.keyboard.press("p");
  await expect(page.getByTestId("berth")).toHaveCount(9);
  await expect(page.getByTestId("berth-keep")).toHaveAttribute("title", /unpin one first/);
});

test("the object can take the whole sheet and give it back", async ({ page }) => {
  await openFloating(page);
  await page.keyboard.press("2");
  await row(page, "crashed").click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  // Opening objects adds nothing to the shell.
  await expect(berths(page)).toHaveText(["ov", "po", "dep", "svc"]);

  await page.getByTestId("widen").click();
  await expect(page.getByTestId("resource-table")).toBeHidden();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  await page.getByTestId("widen").click();
  await expect(row(page, "web-1")).toBeVisible();
});

test("the kinds can be kept open as a column, and floated again", async ({ page }) => {
  await openFloating(page);
  await page.keyboard.press("g");
  await page.getByRole("button", { name: "Pin as column" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  await page.getByTestId("chart-unpin").click();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByTestId("chart-toggle")).toBeVisible();
});

test("the problem pill opens the problem pods and the watch log; a cleared problem ties a knot on the wake line", async ({ page }) => {
  const fake = await openFloating(page);
  await expect(page.getByTestId("deck-headline")).toHaveText("2 pods need a look");
  const crashed = {
    namespace: "demo",
    name: "crashed",
    status: "CrashLoopBackOff",
    reason: "CrashLoopBackOff",
    restarts: 12,
    created: 0,
    owner_kind: "",
    owner_name: "",
  };
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
      problems: [crashed],
      problems_total: 1,
      ...problemGroups([crashed]),
    },
  });
  await expect(page.getByTestId("deck-headline")).toHaveText("1 pod needs a look");
  await expect(page.getByTestId("wake-line").locator(".knot")).toHaveCount(1);

  await page.getByTestId("watch-dial").click();
  const watch = page.getByTestId("watch-panel");
  // The problem pods first (#491); the watch log is the second tab.
  await expect(page.getByTestId("watch-problem")).toHaveCount(1);
  await page.getByTestId("watch-tab-log").click();
  await expect(watch).toContainText("1 cleared today");
  await expect(watch).toContainText("Steady hand");
});
