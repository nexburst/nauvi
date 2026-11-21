import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// The Status column of Deployments, StatefulSets and DaemonSets (#381): one
// word in its tone, led by the container squares' shape for that tone.

const header = (page: Page) => page.getByRole("columnheader", { name: /^Status/ });
const status = (page: Page, name: string) => row(page, name).getByTestId("rollout-status");

/** Adds a stuck and a scaled-down Deployment next to the fixture's web and api. */
function moreDeployments(cluster: import("../fixtures/cluster").FakeCluster) {
  const id = "apps/v1/deployments";
  const cols = cluster.kinds.find((k) => k.id === id)!.columns;
  const at = (key: string) => cols.findIndex((c) => c.key === key);
  const like = (name: string, word: string, problem: string) => {
    const r = structuredClone(cluster.rows[id][0]);
    r.name = name;
    r.key = `demo/${name}`;
    r.cells[at("name")] = name;
    r.cells[at("status")] = word;
    r.problem = problem;
    return r;
  };
  cluster.rows[id].push(
    like("checkout", "Failed", "Rollout stalled (ProgressDeadlineExceeded)"),
    like("batch-worker", "Scaled down", ""),
  );
}

test("Deployments show a Status after Name and Namespace, with a shape per state", async ({ page }) => {
  const fake = await openApp(page, moreDeployments);
  await openKind(page, "Deployments");
  const heads = await page.getByRole("columnheader").allTextContents();
  const names = heads.map((h) => h.replace(/[▲▼]/g, "").trim()).filter(Boolean);
  expect(names.slice(0, 3)).toEqual(["Name", "Namespace", "Status"]);

  await expect(status(page, "web")).toHaveText("Running");
  await expect(status(page, "web")).toHaveAttribute("data-look", "ok");
  await expect(status(page, "api")).toHaveText("Scaling");
  await expect(status(page, "api")).toHaveAttribute("data-look", "warn");
  await expect(status(page, "checkout")).toHaveText("Failed");
  await expect(status(page, "checkout")).toHaveAttribute("data-look", "bad");
  await expect(status(page, "batch-worker")).toHaveAttribute("data-look", "done");

  // The tooltip says why: the row's problem, else what the word means.
  const cell = (name: string) => row(page, name).getByRole("gridcell").filter({ has: page.getByTestId("rollout-status") });
  await expect(cell("checkout")).toHaveAttribute("title", "Failed: Rollout stalled (ProgressDeadlineExceeded)");
  await expect(cell("api")).toHaveAttribute("title", "Scaling: 1 of 3 ready");
  await expect(cell("web")).toHaveAttribute("title", "Running: every wanted pod is there and ready");
  // The filter reads the word.
  await page.getByRole("searchbox", { name: "Filter" }).fill("Failed");
  await expect(page.getByTestId("resource-row")).toHaveCount(1);
  expect(fake.errors).toEqual([]);
});

test("sorting by Status puts a failed rollout first", async ({ page }) => {
  await openApp(page, moreDeployments);
  await openKind(page, "Deployments");
  await header(page).click();
  await header(page).click();
  await expect(header(page)).toHaveAttribute("aria-sort", "descending");
  const first = page.locator('[data-testid="resource-row"][aria-rowindex="2"]');
  await expect(first).toContainText("checkout");
});

test("Status can be hidden in the column chooser, and StatefulSets and DaemonSets have it", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");
  await expect(header(page)).toBeVisible();
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Columns" });
  const box = chooser.getByRole("checkbox", { name: "Status", exact: true });
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.keyboard.press("Escape");
  await expect(header(page)).toHaveCount(0);

  for (const kind of ["StatefulSets", "DaemonSets"]) {
    await openKind(page, kind);
    await expect(header(page)).toBeVisible();
  }
});

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

for (const theme of ["light", "dark"] as const) {
  test(`the Status tones read on the row (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page, moreDeployments);
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await openKind(page, "Deployments");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const words = ["web", "api", "checkout", "batch-worker"].map((n) => status(page, n));
    const colours = await Promise.all(words.map(colour));
    for (const c of colours) expect(contrast(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(3);
    expect(new Set(colours).size).toBe(4);
    await page.screenshot({ path: test.info().outputPath(`rollout-status-${theme}.png`) });
  });
}
