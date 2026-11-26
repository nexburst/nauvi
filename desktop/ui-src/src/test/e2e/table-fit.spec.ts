// Fitted tables (#482): columns as wide as their values, the spare width to
// Name, cut names keeping their end and showing the whole value in the
// tooltip, resizable columns remembered per kind, status icons, and the
// row's own actions on hover. Plus the row menu's Edit YAML and the restart
// that always asks (#494).
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row, rows } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

const CANARY = "payments-worker-canary-7d9f8b6c5-x7k2p";
const WORKER = "payments-worker-7d9f8b6c5-q2w3e";
const NODE = "ip-10-0-123-45.eu-west-1.compute.internal";

// Init functions run in the page as source text: no captured variables.
const longNames = (cluster: FakeCluster) => {
  const pods = cluster.rows["v1/pods"];
  const base = pods[0];
  for (const [name, ns] of [
    ["payments-worker-canary-7d9f8b6c5-x7k2p", "ux486-shop-payments"],
    ["payments-worker-7d9f8b6c5-q2w3e", "ux486-shop-payments"],
  ]) {
    const cells = [...base.cells];
    cells[0] = name;
    cells[1] = ns;
    cells[5] = "ip-10-0-123-45.eu-west-1.compute.internal";
    pods.push({ ...base, key: `${ns}/${name}`, name, namespace: ns, cells });
  }
};

const grid = (page: Page) => page.getByRole("grid");
const header = (page: Page, name: string) => grid(page).getByRole("columnheader", { name, exact: true });
const width = async (page: Page, name: string) => (await header(page, name).boundingBox())!.width;
const panel = (page: Page) => page.getByTestId("detail-panel");
/** A row by the start of its name (a cut name reads differently). */
const rowOf = (page: Page, name: string) =>
  rows(page).filter({ has: page.locator(`.td[title="${name}"], .td:text-is("${name}")`) });
/** The Name cell of a row: the first after the checkbox. */
const nameCell = (page: Page, name: string) => rowOf(page, name).getByRole("gridcell").nth(1);

test("names are not cut while there is room; short columns stay narrow", async ({ page }) => {
  // Room for the 38-character names and the 41-character node.
  await page.setViewportSize({ width: 1720, height: 900 });
  await openApp(page, longNames);
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(7);

  // Every value is whole: nothing is cut, no tooltip stands in for it.
  const cut = await grid(page).locator(".td.cut").count();
  expect(cut).toBe(0);
  await expect(nameCell(page, CANARY)).toHaveText(CANARY);
  await expect(rowOf(page, CANARY).getByRole("gridcell", { name: NODE })).toHaveText(NODE);
  // Short values take what they need, Name the most.
  for (const n of ["Ready", "Restarts", "Age"]) expect(await width(page, n), n).toBeLessThanOrEqual(120);
  expect(await width(page, "Name")).toBeGreaterThan(await width(page, "Namespace"));
  // And the table does not scroll sideways for it.
  const overflow = await page
    .getByTestId("resource-table")
    .locator(".scroller")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("pods-1720.png") });
});

test("at 1280 px Name gives way last, keeping its end; short columns are whole", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, longNames);
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(7);
  // The node and namespace columns gave way before Name.
  const name = nameCell(page, CANARY);
  await expect(name).toHaveText(/^payments-worker-canary.*-x7k2p$/);
  await expect(rowOf(page, CANARY).getByRole("gridcell", { name: NODE })).toHaveClass(/\bcut\b/);
  for (const n of ["Ready", "Status", "Restarts", "Age"]) {
    const i = await grid(page)
      .getByRole("columnheader")
      .evaluateAll((hs, label) => hs.findIndex((h) => h.textContent?.trim() === label), n);
    await expect(rows(page).locator(`> :nth-child(${i + 1}).cut`), n).toHaveCount(0);
  }
  await page.screenshot({ path: test.info().outputPath("pods-1280.png") });
});

test("short of room, a cut name keeps its end and shows the whole name in its tooltip", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openApp(page, longNames);
  await openKind(page, "Pods");
  // On its name: the middle of the row may be a cell's link.
  await row(page, "web-1").getByRole("gridcell").nth(1).click();
  await expect(panel(page)).toBeVisible();

  const canary = nameCell(page, CANARY);
  const worker = nameCell(page, WORKER);
  await expect(canary).toHaveClass(/\bcut\b/);
  await expect(canary).toHaveAttribute("title", CANARY);
  await expect(canary).toHaveAccessibleName(CANARY);
  // The two pods still read differently: their suffixes stay.
  await expect(canary).toHaveText(/^payments.*….*-x7k2p$/);
  await expect(worker).toHaveText(/-q2w3e$/);
  // Short columns are never cut.
  for (const n of ["Ready", "Status", "Restarts", "Age"]) {
    const i = await grid(page)
      .getByRole("columnheader")
      .evaluateAll((hs, label) => hs.findIndex((h) => h.textContent?.trim() === label), n);
    await expect(rows(page).locator(`> :nth-child(${i + 1}).cut`), n).toHaveCount(0);
  }
  await page.screenshot({ path: test.info().outputPath("pods-panel.png") });
});

test("a header edge drags to resize, is remembered per kind, and double-click fits", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page, longNames);
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(7);

  const before = await width(page, "Namespace");
  const handle = grid(page).locator('[data-testid="col-resize"][data-col="namespace"]');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => width(page, "Namespace")).toBeGreaterThan(before + 80);
  const sized = Math.round(await width(page, "Namespace"));
  // Not a sort: the drag is not a click on the header.
  await expect(header(page, "Namespace")).toHaveAttribute("aria-sort", "none");

  // Saved with the kind's settings, and back after another kind.
  const saved = (await fake.calls("cmdUpdateSettings")).map((c) => JSON.stringify(c));
  expect(saved.some((c) => c.includes('"namespace":' + sized))).toBe(true);
  await openKind(page, "Deployments");
  await expect(row(page, "web")).toBeVisible();
  // Deployments have their own widths.
  expect(Math.round(await width(page, "Namespace"))).not.toBe(sized);
  await openKind(page, "Pods");
  await expect.poll(async () => Math.round(await width(page, "Namespace"))).toBe(sized);

  // Double-click: the column fits its values again.
  await handle.dblclick();
  await expect.poll(async () => Math.round(await width(page, "Namespace"))).toBe(Math.round(before));
  expect(fake.errors).toEqual([]);
});

test("a status reads from its icon too, not only its colour", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  const status = (name: string) => row(page, name).getByRole("gridcell", { name: /^(Running|Pending|CrashLoopBackOff)$/ });
  await expect(status("web-1").locator("svg[data-icon]")).toHaveAttribute("data-icon", "ok");
  await expect(status("db-0").locator("svg[data-icon]")).toHaveAttribute("data-icon", "pending");
  await expect(status("crashed").locator("svg[data-icon]")).toHaveAttribute("data-icon", "error");
});

test("a hovered row shows its logs, shell and YAML actions", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await expect(rows(page).getByTestId("row-quick")).toHaveCount(0);
  await row(page, "web-2").hover();
  const quick = row(page, "web-2").getByTestId("row-quick");
  await expect(quick.getByRole("button")).toHaveCount(3);
  await expect(quick.getByTestId("row-logs")).toHaveAccessibleName("Logs of web-2");
  await expect(quick.getByTestId("row-shell")).toHaveAttribute("title", "Shell (S)");
  await page.screenshot({ path: test.info().outputPath("hover.png") });

  // YAML opens the panel on its editor, without the row's click opening it plain.
  await quick.getByTestId("row-edit").click();
  await expect(panel(page)).toContainText("web-2");
  await expect(panel(page).getByTestId("yaml-editor")).toBeInViewport();

  await row(page, "web-1").hover();
  await row(page, "web-1").getByTestId("row-logs").click();
  await expect(page.getByTestId("dock")).toBeVisible();

  // A Deployment has logs and YAML, no shell.
  await openKind(page, "Deployments");
  await row(page, "web").hover();
  await expect(row(page, "web").getByTestId("row-quick").getByRole("button")).toHaveCount(2);
  await expect(row(page, "web").getByTestId("row-shell")).toHaveCount(0);
});

test("every row menu offers Edit YAML after the dock entries, with the keys (#494)", async ({ page }) => {
  await openApp(page);
  for (const [kind, name, first] of [
    ["Pods", "web-1", ["Logs", "Shell", "Edit YAML"]],
    ["Deployments", "web", ["Logs", "Edit YAML"]],
    ["Config Maps", "settings", ["Edit YAML"]],
  ] as const) {
    await openKind(page, kind);
    await row(page, name).getByTestId("row-menu").click();
    const menu = page.getByRole("menu");
    const labels = await menu.getByRole("menuitem").allTextContents();
    expect(labels.slice(0, first.length), kind).toEqual(first);
    // Each with its key, so the menu teaches it.
    const key = (label: string) =>
      menu.locator(".item", { has: page.getByRole("menuitem", { name: label, exact: true }) }).locator("kbd");
    await expect(key("Edit YAML")).toHaveText("E");
    if (kind === "Deployments") {
      await expect(key("Logs")).toHaveText("L");
      await expect(key("Rollout restart")).toHaveText("⇧R");
      await page.screenshot({ path: test.info().outputPath("menu-deployment.png") });
    }
    await page.keyboard.press("Escape");
  }

  await openKind(page, "Pods");
  await row(page, "db-0").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit YAML", exact: true }).click();
  await expect(panel(page)).toContainText("db-0");
  await expect(panel(page).getByTestId("yaml-editor")).toBeInViewport();

  // A Deployment's panel opens on its YAML tab.
  await openKind(page, "Deployments");
  await row(page, "web").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit YAML", exact: true }).click();
  await expect(panel(page).getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
});

test("Rollout restart asks first from the menu and the panel, as from Shift+R (#494)", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").getByTestId("row-menu").click();
  await page.getByRole("menuitem", { name: "Rollout restart", exact: true }).click();
  const dialog = page.getByTestId("action-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("web");
  expect(await fake.calls("cmdRunAction")).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await row(page, "web").click();
  await panel(page).locator('button[data-action="restart"]').click();
  await expect(dialog).toBeVisible();
  expect(await fake.calls("cmdRunAction")).toEqual([]);
});
